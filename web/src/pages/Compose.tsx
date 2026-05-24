/**
 * Compose / reply. The plaintext goes to the server during send (it must,
 * for SMTP delivery). Drafts, however, are encrypted client-side to the
 * user's own pubkey before upload — the server only stores ciphertext for
 * drafts at rest.
 */

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import RecipientField, { type Recipient } from '@/components/RecipientField';
import { invalidateContacts } from '@/lib/contacts';
import * as api from '@/lib/api';
import { useApp } from '@/lib/store';
import { b64uDecode, b64uEncode, sealToSelf, utf8 } from '@/lib/crypto';
import * as secretLink from '@/lib/secret-link';
import type { SecretPolicy } from '@/lib/secret-link';
import { uploadFile } from '@/lib/uploads';
import * as hosted from '@/lib/hosted';
import { b64uDecode as decodeB64, b64uEncode as encodeB64 } from '@/lib/b64';
import {
  deleteDraftHosted,
  getDraftHosted,
  putDraftHosted,
  type DraftHostedState,
} from '@/lib/idb';

interface Attachment {
  id: string;
  r2_key: string;
  filename: string;
  filename_ct_b64: string | null;
  mime: string;
  size_bytes: number;
}

/** Files large enough to bounce as inline MIME (~10 MiB+) get
 *  encrypted client-side and uploaded as `hosted/...` instead. The
 *  CEK lives only in the URL fragment of the share link the sender
 *  emails out, so the server never sees plaintext. */
interface HostedAttachment {
  /** Locally unique per draft — used by the UI to remove a row. */
  id: string;
  filename: string;
  mime: string;
  plaintext_size: number;
  /** Output of `uploadHostedFile`. */
  prepared: hosted.PreparedHostedFile;
}

/** Any file ≥ this many plaintext bytes goes hosted (E2E, link in body)
 *  instead of inline MIME. Small enough to keep most emails inline,
 *  big enough that we don't force users through the hosted flow for
 *  no real reason. */
const HOSTED_THRESHOLD_BYTES = 10 * 1024 * 1024;

interface ReplyState {
  replyToMessageId?: string;
  replyToThreadId?: string;
  messageId?: string;
  references?: string;
  to?: string[];
  subject?: string;
  /** Resuming an existing draft (e.g. clicked from /drafts). When
   *  present, Compose uses this as both the server draftId and the
   *  IDB hosted-state key so refresh restores hosted attachments. */
  draftId?: string;
}

export default function Compose() {
  const nav = useNavigate();
  const location = useLocation();
  const { state } = useApp();
  const rs = (location.state ?? {}) as ReplyState;

  const myAddresses = state.me?.addresses ?? [];
  const [from, setFrom] = useState(myAddresses[0] ?? '');
  // to/cc/bcc are tag-style: each entry has the raw address plus an
  // optional display name (populated from the contact list when the
  // user picks a suggestion). Send/serialization uses `addr`; the
  // `name` is purely UI.
  const [to, setTo] = useState<Recipient[]>(
    () => (rs.to ?? []).map((a) => ({ addr: a })),
  );
  const [cc, setCc] = useState<Recipient[]>([]);
  const [bcc, setBcc] = useState<Recipient[]>([]);
  const [subject, setSubject] = useState(rs.subject ?? '');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Generate the draft id up front so it can double as the IDB key
  // for hosted-attachment recovery from the very first file pick. If
  // we're resuming an existing draft (clicked from /drafts), reuse
  // the server's id. The server upserts at whatever id we supply, so
  // round-tripping a client-minted id is safe.
  const [draftId, setDraftId] = useState<string>(
    () => rs.draftId ?? `drft_${crypto.randomUUID().replace(/-/g, '')}`,
  );
  // No-op setter retained for parity with the old shape — autosave
  // writes back whatever the server returns; if a server ever
  // rewrites our supplied id we'd want to know.
  void setDraftId;
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [hostedAttachments, setHostedAttachments] = useState<HostedAttachment[]>([]);
  /** One CEK per draft — generated lazily on the first hosted-eligible
   *  attachment, persisted to IndexedDB so a refresh / tab reload
   *  doesn't strand the ciphertext on R2 without a key. */
  const hostedCekRef = useRef<Uint8Array | null>(null);
  const [hostedHydrated, setHostedHydrated] = useState(false);

  // Hydrate hosted state from IDB on mount. Runs once; we don't
  // re-read on every draftId change because draftId is generated
  // once at mount and doesn't move.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await getDraftHosted(draftId);
        if (cancelled || !saved) {
          setHostedHydrated(true);
          return;
        }
        hostedCekRef.current = decodeB64(saved.cek_b64);
        setHostedAttachments(
          saved.files.map((f) => ({
            id: f.id,
            filename: f.filename,
            mime: f.mime,
            plaintext_size: f.plaintext_size,
            prepared: f.prepared as HostedAttachment['prepared'],
          })),
        );
      } catch {
        /* IDB unavailable or schema mismatch — ignore */
      } finally {
        if (!cancelled) setHostedHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist hosted state on every change. Runs only after hydration
  // so we don't clobber a saved draft on the first render.
  useEffect(() => {
    if (!hostedHydrated) return;
    if (!hostedCekRef.current && hostedAttachments.length === 0) {
      void deleteDraftHosted(draftId);
      return;
    }
    if (!hostedCekRef.current) return;
    const state: DraftHostedState = {
      cek_b64: encodeB64(hostedCekRef.current),
      files: hostedAttachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        plaintext_size: a.plaintext_size,
        prepared: a.prepared,
      })),
    };
    void putDraftHosted(draftId, state);
  }, [hostedHydrated, hostedAttachments, draftId]);
  const [attachingFile, setAttachingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Secret-link mode — when enabled, on Send we encrypt subject/body/atts
  // with a password-derived key, store the ciphertext server-side, and the
  // outbound email body is replaced with a link + hint. See
  // `web/src/lib/secret-link.ts` and `worker/src/api/secret.rs`.
  const [secretMode, setSecretMode] = useState(false);
  const [secretPassword, setSecretPassword] = useState('');
  const [secretPasswordConfirm, setSecretPasswordConfirm] = useState('');
  const [secretHint, setSecretHint] = useState('');
  const [secretPolicy, setSecretPolicy] = useState<SecretPolicy>('14d');

  const myPub = useMemo(() => {
    if (!state.me?.pub_key_b64) return null;
    try {
      return b64uDecode(state.me.pub_key_b64);
    } catch { return null; }
  }, [state.me?.pub_key_b64]);

  // Auto-save draft (debounced).
  useEffect(() => {
    if (!myPub) return;
    const handle = setTimeout(async () => {
      if (!subject && !body && !to) return;
      try {
        const payload = {
          id: draftId,
          in_reply_to_message_id: rs.replyToMessageId ?? null,
          to_addrs: to.map((r) => r.addr),
          cc_addrs: cc.map((r) => r.addr),
          bcc_addrs: bcc.map((r) => r.addr),
          subject_ct_b64: subject ? b64uEncode(sealToSelf(utf8(subject), myPub)) : null,
          body_ct_b64: body ? b64uEncode(sealToSelf(utf8(body), myPub)) : null,
          attachments: [],
        };
        const r = await api.post<{ id: string; updated_at: number }>(
          '/api/drafts',
          payload,
        );
        setDraftId(r.id);
        setSavedAt(r.updated_at);
      } catch { /* silent — autosave is best-effort */ }
    }, 1500);
    return () => clearTimeout(handle);
  }, [subject, body, to, cc, bcc, draftId, myPub]);

  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Tell Chromium to wrap new paragraphs in <p> instead of <div>. Combined
  // with the lazy-seed in cmd() below, this makes formatBlock + list
  // commands behave consistently the first time the user clicks one.
  useEffect(() => {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
  }, []);

  /**
   * Run a formatting command against the contentEditable selection, then
   * sync our React-side `body` to the resulting innerHTML so autosave and
   * send see the latest state. document.execCommand is deprecated on
   * paper but remains the only cross-browser way to mutate a
   * contentEditable selection with native undo/redo support.
   */
  const cmd = (name: string, value?: string) => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();

    // Block-level commands (lists, blockquote, code-block) need an
    // existing block ancestor for the cursor; Chrome silently no-ops if
    // the editable has only raw text nodes. Seed one lazily — wrap
    // whatever is in the editable in a <p> and move the cursor to its
    // end before invoking. This keeps the editable's HTML clean for
    // people who never use formatting (we don't pre-seed an empty <p>
    // on mount).
    if (BLOCK_COMMANDS.has(name) && !el.querySelector(BLOCK_TAGS)) {
      const p = document.createElement('p');
      while (el.firstChild) p.appendChild(el.firstChild);
      if (p.childNodes.length === 0) p.appendChild(document.createElement('br'));
      el.appendChild(p);
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(p);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }

    // formatBlock specifically wants the value wrapped in angle brackets
    // across browser engines (`<blockquote>`, not `blockquote`). Other
    // commands take their value as-is (createLink → URL string).
    const arg =
      name === 'formatBlock' && value
        ? `<${value.replace(/[<>]/g, '')}>`
        : value;
    try {
      document.execCommand(name, false, arg);
    } catch { /* ignore — some browsers throw for unsupported commands */ }
    setBody(el.innerHTML);
  };

  /**
   * Wrap the current selection (or, with a collapsed cursor, an empty
   * inline tag containing a zero-width space) so the user can type into
   * the wrapped region. execCommand('insertHTML', '<code>code</code>')
   * — the previous implementation — literally wrote the word "code" as
   * placeholder text, which is what the user saw.
   */
  const wrapInline = (tag: 'code') => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    if (!range.collapsed) {
      const node = document.createElement(tag);
      node.appendChild(range.extractContents());
      range.insertNode(node);
      // Put the caret right after the new wrap so the user can keep
      // typing in non-code formatting.
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      // Empty cursor — insert <tag>​</tag> and place the caret
      // *inside* the tag so subsequent keystrokes extend it. The ZWS
      // is necessary because empty inline elements collapse out of
      // contentEditable rendering.
      const node = document.createElement(tag);
      const zws = document.createTextNode('​');
      node.appendChild(zws);
      range.insertNode(node);
      const inside = document.createRange();
      inside.setStart(zws, 1);
      inside.collapse(true);
      sel.removeAllRanges();
      sel.addRange(inside);
    }
    setBody(el.innerHTML);
  };

  const insertLink = () => {
    const url = prompt('url') ?? '';
    if (!url) return;
    cmd('createLink', url);
  };

  /**
   * Upload selected files as attachments. Bytes go to /api/attachments
   * as-is (plaintext) so outbound MIME can include them when the user
   * hits Send. The filename is also sealed-to-self and uploaded so the
   * sender's at-rest copy stores it encrypted — the recipient sees the
   * plaintext filename in MIME, but our DO row stores ciphertext.
   */
  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachingFile(true);
    try {
      for (const file of Array.from(files)) {
        // Per-file routing: small files go inline MIME (`attach`), big
        // ones go E2E-encrypted hosted with the CEK that'll appear in
        // the share link's URL fragment.
        if (file.size >= HOSTED_THRESHOLD_BYTES) {
          if (!hostedCekRef.current) {
            hostedCekRef.current = hosted.newHostedCek();
          }
          const prepared = await hosted.uploadHostedFile({
            input: {
              filename: file.name,
              mime: file.type || 'application/octet-stream',
              file,
            },
            cek: hostedCekRef.current,
          });
          setHostedAttachments((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              filename: file.name,
              mime: file.type || 'application/octet-stream',
              plaintext_size: file.size,
              prepared,
            },
          ]);
          continue;
        }

        const filenameCt = myPub
          ? b64uEncode(sealToSelf(utf8(file.name), myPub))
          : null;
        const r = await uploadFile({
          kind: 'attach',
          source: file,
          mime: file.type || 'application/octet-stream',
          filenameCtB64: filenameCt ?? undefined,
        });
        if (!r.attachment_id) {
          throw new Error('upload completed but server returned no attachment id');
        }
        setAttachments((prev) => [
          ...prev,
          {
            id: r.attachment_id!,
            r2_key: r.r2_key,
            filename: file.name,
            filename_ct_b64: filenameCt,
            mime: file.type || 'application/octet-stream',
            size_bytes: file.size,
          },
        ]);
      }
    } catch (e: any) {
      setErr(e?.message || 'attachment upload failed');
    } finally {
      setAttachingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** Drop a hosted attachment locally. The R2 ciphertext stays until
   *  the daily orphan sweep — there's no per-blob delete endpoint yet
   *  (the hosted_downloads row owns lifecycle once /api/hosted/create
   *  runs, and we don't call create until send). */
  const removeHostedAttachment = (id: string) => {
    setHostedAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const removeAttachment = async (att: Attachment) => {
    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    try { await api.del(`/api/attachments/${encodeURIComponent(att.id)}`); } catch { /* ignore */ }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // body is the contentEditable's innerHTML. Send the HTML directly
      // for HTML-capable clients, and derive a readable text/plain
      // fallback so legacy clients still get something sensible. No
      // sanitization needed here — recipients' mail clients sandbox HTML,
      // and the source is the user's own keystrokes.
      const html = body.trim().length > 0 ? body : null;
      const text = html ? htmlToPlainText(html) : '';

      const recipients = to.map((r) => r.addr);
      let bodyText = text;
      let bodyHtml = html;

      // E2E hosted attachments: if the user added any oversize files,
      // mint a hosted_downloads row with the encrypted metadata, then
      // splice the share link into the outbound body. The URL fragment
      // (the CEK) never reaches the server — the recipient's browser
      // reads it from location.hash to decrypt.
      if (hostedAttachments.length > 0 && hostedCekRef.current) {
        const cek = hostedCekRef.current;
        // Seal CEK to sender's own X25519 pubkey so the /hosted
        // dashboard can re-decrypt later without keeping the URL
        // fragment around. Skipped silently if we don't have a
        // pubkey on hand — re-view simply won't work, the recipient
        // path still does.
        const senderWrap = myPub ? b64uEncode(sealToSelf(cek, myPub)) : undefined;
        const created = await hosted.createHostedLink({
          files: hostedAttachments.map((a) => a.prepared),
          recipient_addrs: [
            ...recipients,
            ...cc.map((r) => r.addr),
            ...bcc.map((r) => r.addr),
          ],
          subject: subject || null,
          sender_cek_wrap_b64: senderWrap,
        });
        const shareUrl = hosted.buildShareUrl(created.url_prefix, cek);
        const senderLabel = state.me?.display_name || from;
        const totalBytes = hostedAttachments.reduce(
          (n, a) => n + a.plaintext_size,
          0,
        );
        const fileLines = hostedAttachments
          .map((a) => `  • ${a.filename} (${formatBytesShort(a.plaintext_size)})`)
          .join('\n');
        const blurb =
          `\n\n— large attachments delivered via end-to-end encrypted link —\n` +
          `${senderLabel} sent ${hostedAttachments.length} file` +
          `${hostedAttachments.length === 1 ? '' : 's'} ` +
          `(${formatBytesShort(totalBytes)} total).\n` +
          `Open: ${shareUrl}\n` +
          `(link expires in 14 days; encrypted with a key only in the URL — ` +
          `the server cannot decrypt)\n\nFiles:\n${fileLines}\n`;
        bodyText = `${bodyText}${blurb}`;
        const htmlItems = hostedAttachments
          .map(
            (a) =>
              `<li>${escapeHtml(a.filename)} <span style="color:#666">(${formatBytesShort(a.plaintext_size)})</span></li>`,
          )
          .join('');
        const blurbHtml =
          `<hr/><p style="color:#666;font-size:13px">— large attachments delivered via end-to-end encrypted link —</p>` +
          `<p>${escapeHtml(senderLabel)} sent ${hostedAttachments.length} file` +
          `${hostedAttachments.length === 1 ? '' : 's'} (${formatBytesShort(totalBytes)} total).</p>` +
          `<p><a href="${escapeHtml(shareUrl)}">Open encrypted download</a> ` +
          `(link expires in 14 days; the key is in the URL fragment — ` +
          `our server cannot decrypt the contents)</p>` +
          `<ul style="font-size:13px">${htmlItems}</ul>`;
        bodyHtml = (bodyHtml ?? '') + blurbHtml;
      }

      // Secret mode replaces the outbound payload entirely: the actual
      // subject/body/attachments are encrypted client-side and stored on
      // our server keyed by a password the sender shares out-of-band. The
      // email itself only carries a link + optional hint.
      if (secretMode) {
        if (!secretPassword) throw new Error('set a password for the secret link');
        if (secretPassword !== secretPasswordConfirm)
          throw new Error('password and confirmation do not match');
        if (recipients.length !== 1)
          throw new Error('secret links go to exactly one recipient');
        // Pre-flight size caps, mirroring the worker's enforced limits.
        const totalAttachBytes = attachments.reduce((n, a) => n + a.size_bytes, 0);
        const oversized = attachments.find(
          (a) => a.size_bytes > secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES,
        );
        if (oversized) {
          throw new Error(
            `"${oversized.filename}" exceeds the ${formatMiB(
              secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES,
            )} per-file limit for secret links`,
          );
        }
        if (totalAttachBytes > secretLink.SECRET_MAX_LINK_BYTES) {
          throw new Error(
            `attachments total ${formatMiB(totalAttachBytes)}, exceeding the ${formatMiB(
              secretLink.SECRET_MAX_LINK_BYTES,
            )} per-link cap`,
          );
        }

        // Pull attachment plaintexts back from R2. Each was uploaded above
        // through the regular attachments path; for the secret link we
        // need raw bytes again so we can re-encrypt + re-upload through
        // the chunked secret-link path. /api/attachments/:id streams.
        const attsPlain: secretLink.SecretAttachmentInput[] = [];
        for (const a of attachments) {
          const resp = await api.rawFetch('GET', `/api/attachments/${encodeURIComponent(a.id)}`, '');
          if (!resp.ok) throw new Error(`failed to read attachment ${a.filename}`);
          const bytes = new Uint8Array(await resp.arrayBuffer());
          attsPlain.push({ filename: a.filename, mime: a.mime, bytes });
        }

        const payload = await secretLink.prepareCreateRequest({
          password: secretPassword,
          subject,
          // Use the HTML body if there is one; otherwise plaintext. The
          // viewer renders HTML in a sandboxed surface.
          body: html ?? text,
          attachments: attsPlain,
          recipient: recipients[0],
          hint: secretHint || null,
          policy: secretPolicy,
        });

        const created = await api.post<{ token: string; url: string }>(
          '/api/secret/create',
          payload,
        );

        // Outbound email body: link + optional hint, in both plaintext
        // and a minimal HTML alternative. No attachments — they live
        // inside the link.
        const senderLabel = state.me?.display_name || from;
        const hintLine = secretHint ? `\n\nPassword hint: ${secretHint}` : '';
        const linkText =
          `${senderLabel} sent you a secret message.\n\n` +
          `Open it here: ${created.url}\n\n` +
          `You'll need the password we agreed on.` +
          hintLine;
        const linkHtml =
          `<p>${escapeHtml(senderLabel)} sent you a secret message.</p>` +
          `<p><a href="${escapeAttr(created.url)}">Open the secret message</a></p>` +
          `<p>You'll need the password we agreed on.` +
          (secretHint ? ` <em>Hint:</em> ${escapeHtml(secretHint)}` : '') +
          `</p>`;
        // Delete the staged plaintext attachments now that the encrypted
        // copies are persisted on the secret-link row — we don't want
        // them lingering in the user's mailbox unattached.
        for (const a of attachments) {
          try { await api.del(`/api/attachments/${encodeURIComponent(a.id)}`); } catch {}
        }
        await api.post('/api/messages/send', {
          from,
          from_name: state.me?.display_name || null,
          to: recipients,
          cc: cc.map((r) => r.addr),
          bcc: bcc.map((r) => r.addr),
          subject: subject || '(secret message)',
          text: linkText,
          html: linkHtml,
          in_reply_to: rs.messageId ?? null,
          references: rs.references ?? null,
          attachments: [],
        });
        if (draftId) {
          try { await api.del(`/api/drafts/${draftId}`); } catch {}
        }
        nav(rs.replyToThreadId ? `/thread/${rs.replyToThreadId}` : '/sent', { replace: true });
        return;
      }

      await api.post('/api/messages/send', {
        from,
        from_name: state.me?.display_name || null,
        to: recipients,
        cc: cc.map((r) => r.addr),
        bcc: bcc.map((r) => r.addr),
        subject,
        text: bodyText,
        html: bodyHtml,
        in_reply_to: rs.messageId ?? null,
        references: rs.references ?? null,
        attachments: attachments.map((a) => ({
          r2_key: a.r2_key,
          filename: a.filename,
          filename_ct_b64: a.filename_ct_b64,
          mime: a.mime,
        })),
      });
      // Invalidate the contact cache so the next typeahead reflects
      // this send (any new recipient is now a known contact).
      void invalidateContacts();
      if (draftId) {
        try { await api.del(`/api/drafts/${draftId}`); } catch {}
      }
      // Hosted-attachment row is committed server-side now — drop the
      // local IDB copy so a future Compose mount at this draftId
      // (extremely unlikely; UUIDs don't recycle) doesn't hydrate
      // stale hosted state.
      void deleteDraftHosted(draftId);
      hostedCekRef.current = null;
      nav(rs.replyToThreadId ? `/thread/${rs.replyToThreadId}` : '/sent', { replace: true });
    } catch (e: any) {
      setErr(e?.message || 'send failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} className="flex h-full flex-col">
      <Toolbar
        right={
          <>
            <span className="text-mute label">
              {savedAt ? 'draft saved' : ''}
            </span>
            <button type="button" className="btn label" onClick={() => nav(-1)}>
              cancel
            </button>
            <button type="submit" className="btn btn-primary label" disabled={busy || !from || !to}>
              {busy ? 'sending…' : 'send ▸'}
            </button>
          </>
        }
      >
        <span className="label">{rs.replyToMessageId ? 'reply' : 'new message'}</span>
      </Toolbar>

      <div className="hair-b">
        <div className="field">
          <div className="field-label">from</div>
          <select
            className="field-value w-full border-0"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {myAddresses.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <RecipientField
          label="to"
          value={to}
          onChange={setTo}
          required
          placeholder="someone@example.com"
          myAddresses={myAddresses}
        />
        <RecipientField
          label="cc"
          value={cc}
          onChange={setCc}
          myAddresses={myAddresses}
        />
        <RecipientField
          label="bcc"
          value={bcc}
          onChange={setBcc}
          myAddresses={myAddresses}
          autocomplete={false}
        />
        <div className="field">
          <div className="field-label">subject</div>
          <input
            className="field-value w-full border-0"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      </div>

      {secretMode && (
        <div className="hair-b bg-[var(--bg-mute,#f5f5f5)] px-3 py-2 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <span className="label">secret link — encrypted, password-gated</span>
            <button
              type="button"
              className="btn label text-xs"
              onClick={() => setSecretMode(false)}
            >
              cancel secret mode
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-mute">password</span>
              <input
                className="border px-2 py-1 font-mono"
                type="password"
                value={secretPassword}
                onChange={(e) => setSecretPassword(e.target.value)}
                autoComplete="new-password"
                required={secretMode}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-mute">confirm password</span>
              <input
                className="border px-2 py-1 font-mono"
                type="password"
                value={secretPasswordConfirm}
                onChange={(e) => setSecretPasswordConfirm(e.target.value)}
                autoComplete="new-password"
                required={secretMode}
              />
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-mute">
                hint <span className="text-[10px]">(shown in the email — no secrets)</span>
              </span>
              <input
                className="border px-2 py-1"
                value={secretHint}
                onChange={(e) => setSecretHint(e.target.value)}
                placeholder="e.g. the thing we talked about saturday"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-mute">expires</span>
              <select
                className="border px-2 py-1"
                value={secretPolicy}
                onChange={(e) => setSecretPolicy(e.target.value as SecretPolicy)}
              >
                <option value="one_time">one-time view</option>
                <option value="1h">1 hour after open</option>
                <option value="24h">24 hours after open</option>
                <option value="14d">14 days after open</option>
                <option value="never">never (1 year max)</option>
              </select>
            </label>
          </div>
          <p className="text-mute mt-2 text-[11px]">
            Share the password with the recipient out-of-band (Signal, SMS, in
            person). It is never sent in the email.
          </p>
        </div>
      )}

      {/*
        The body composer. contentEditable means the user sees formatted
        text live — typing into a bold range stays bold, list items get a
        visible bullet, etc. We keep React's `body` state in sync via
        onInput so autosave and send always see the latest innerHTML.
        Initial content (e.g. quoted reply, restored draft) can be set
        on mount via the ref; we leave it empty here for now.
      */}
      <div
        ref={bodyRef}
        className="prose-sm flex-1 w-full overflow-y-auto p-4 text-sm leading-relaxed focus:outline-none"
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => setBody((e.currentTarget as HTMLDivElement).innerHTML)}
        data-placeholder="message…"
        style={{ minHeight: '12rem' }}
      />

      {(attachments.length > 0 || hostedAttachments.length > 0) && (
        <div className="hair-t flex flex-wrap items-center gap-2 px-3 py-2">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="hair-all flex items-center gap-2 px-2 py-1 text-xs"
              title={`${a.mime} · ${formatBytes(a.size_bytes)} · inline MIME`}
            >
              <span className="truncate max-w-[16rem]">{a.filename}</span>
              <span className="text-mute">{formatBytes(a.size_bytes)}</span>
              <button
                type="button"
                className="text-mute hover:text-black"
                onClick={() => void removeAttachment(a)}
                title="remove"
              >
                ×
              </button>
            </span>
          ))}
          {hostedAttachments.map((a) => (
            <span
              key={a.id}
              className="hair-all flex items-center gap-2 px-2 py-1 text-xs"
              title={`${a.mime} · ${formatBytes(a.plaintext_size)} · E2E-encrypted link in body`}
            >
              <span aria-hidden>🔐</span>
              <span className="truncate max-w-[16rem]">{a.filename}</span>
              <span className="text-mute">{formatBytes(a.plaintext_size)} · link</span>
              <button
                type="button"
                className="text-mute hover:text-black"
                onClick={() => removeHostedAttachment(a.id)}
                title="remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Formatting toolbar — at the bottom of the form so it stays
          close to the keyboard on mobile and out of the way until the
          user actually wants to format. */}
      <div className="hair-t flex flex-wrap items-center gap-1 px-2 py-1">
        {/* Inline styling stays — bold/italic/strike behave reliably
            via execCommand. List / blockquote / code / code-block /
            link were removed because contentEditable + execCommand
            for block-level formatting is unreliable across browsers
            (cursor escapes the block, ranges collapse, nesting
            breaks) and the bugs outweighed the value. Plain text in
            the message body is fine for now. */}
        <FmtBtn label="B" title="bold" bold onClick={() => cmd('bold')} />
        <FmtBtn label="I" title="italic" italic onClick={() => cmd('italic')} />
        <FmtBtn label="S" title="strikethrough" strike
          onClick={() => cmd('strikeThrough')} />
        <span className="text-mute mx-1">|</span>
        <FmtBtn label={attachingFile ? '⏳ attach' : '📎 attach'}
          title="attach a file"
          onClick={() => fileInputRef.current?.click()} />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void uploadFiles(e.target.files)}
        />
        <span className="text-mute mx-1">|</span>
        <FmtBtn
          label={secretMode ? '🔒 secret on' : '🔒 secret'}
          title="send as password-protected link"
          onClick={() => setSecretMode((v) => !v)}
        />
        {/* Lightweight explainer — a hover tooltip via title, plus a
            persistent expandable on click for users who want to read
            the model in detail. */}
        <button
          type="button"
          className="btn label py-1 px-2 text-xs"
          title={
            'Secret mode: we encrypt your subject, body, and attachments in your browser ' +
            'with a key derived from a password you set. The recipient gets a link instead ' +
            'of the message. When they open the link, they enter the password, the content ' +
            'decrypts in their browser, and we never see the password or the plaintext. ' +
            'Share the password out-of-band (Signal, SMS, in person).'
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSecretMode(true)}
        >
          ?
        </button>
      </div>

      {err && <div className="hair-t inv px-3 py-2 text-sm">{err}</div>}
    </form>
  );
}

/** execCommand names that operate on block ancestors (not inline ranges). */
const BLOCK_COMMANDS = new Set([
  'insertUnorderedList',
  'insertOrderedList',
  'formatBlock',
]);

/** CSS selector matching block-level tags execCommand recognizes as block ancestors. */
const BLOCK_TAGS = 'p, div, blockquote, ul, ol, pre, h1, h2, h3, h4, h5, h6';

function FmtBtn({
  label,
  title,
  onClick,
  bold,
  italic,
  strike,
}: {
  label: string;
  title: string;
  onClick: () => void;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}) {
  let cls = 'btn label py-1 px-2 text-xs';
  if (bold) cls += ' font-bold';
  if (italic) cls += ' italic';
  if (strike) cls += ' line-through';
  return (
    <button
      type="button"
      className={cls}
      title={title}
      onMouseDown={(e) => e.preventDefault() /* don't steal textarea focus */}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Stricter escape for use inside HTML attributes — same shape but never
 *  emits unescaped quotes. The outbound link HTML uses href="..." so we
 *  must escape `"` (and amp + lt for good measure). */
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Best-effort HTML → plain text for the `text/plain` MIME alternative.
 * Browsers don't give us a parsed-document-to-text utility, so we
 * shovel through innerText on a hidden node: handles block breaks,
 * <br>s, and entity decoding correctly without pulling in a dep.
 */
function htmlToPlainText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  // innerText respects display/visibility so block elements get line
  // breaks the way they would visually.
  return (div.innerText ?? div.textContent ?? '').trim();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Slightly shorter form used inside the outbound-email blurb that
 *  introduces hosted-link attachments. Keeps the email body terse. */
function formatBytesShort(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// `splitAddrs` retired — the to/cc/bcc inputs are now tag-based via
// RecipientField, which manages parsing + dedup internally.

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}
