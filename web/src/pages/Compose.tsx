/**
 * Compose / reply. The plaintext goes to the server during send (it must,
 * for SMTP delivery). Drafts, however, are encrypted client-side to the
 * user's own pubkey before upload — the server only stores ciphertext for
 * drafts at rest.
 */

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

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

interface HostedAttachment {
  id: string;
  filename: string;
  mime: string;
  plaintext_size: number;
  prepared: hosted.PreparedHostedFile;
}

const HOSTED_THRESHOLD_BYTES = 10 * 1024 * 1024;

interface ReplyState {
  replyToMessageId?: string;
  replyToThreadId?: string;
  messageId?: string;
  references?: string;
  to?: string[];
  subject?: string;
  draftId?: string;
}

export default function Compose() {
  const nav = useNavigate();
  const location = useLocation();
  const { state } = useApp();
  const rs = (location.state ?? {}) as ReplyState;

  const myAddresses = state.me?.addresses ?? [];
  const [from, setFrom] = useState(myAddresses[0] ?? '');
  const [to, setTo] = useState<Recipient[]>(
    () => (rs.to ?? []).map((a) => ({ addr: a })),
  );
  const [cc, setCc] = useState<Recipient[]>([]);
  const [bcc, setBcc] = useState<Recipient[]>([]);
  const [subject, setSubject] = useState(rs.subject ?? '');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string>(
    () => rs.draftId ?? `drft_${crypto.randomUUID().replace(/-/g, '')}`,
  );
  void setDraftId;
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [hostedAttachments, setHostedAttachments] = useState<HostedAttachment[]>([]);
  const hostedCekRef = useRef<Uint8Array | null>(null);
  const [hostedHydrated, setHostedHydrated] = useState(false);

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
        /* IDB unavailable or schema mismatch */
      } finally {
        if (!cancelled) setHostedHydrated(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hostedHydrated) return;
    if (!hostedCekRef.current && hostedAttachments.length === 0) {
      void deleteDraftHosted(draftId);
      return;
    }
    if (!hostedCekRef.current) return;
    const st: DraftHostedState = {
      cek_b64: encodeB64(hostedCekRef.current),
      files: hostedAttachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        plaintext_size: a.plaintext_size,
        prepared: a.prepared,
      })),
    };
    void putDraftHosted(draftId, st);
  }, [hostedHydrated, hostedAttachments, draftId]);

  const [attachingFile, setAttachingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [secretMode, setSecretMode] = useState(false);
  const [secretPassword, setSecretPassword] = useState('');
  const [secretPasswordConfirm, setSecretPasswordConfirm] = useState('');
  const [secretHint, setSecretHint] = useState('');
  const [secretPolicy, setSecretPolicy] = useState<SecretPolicy>('14d');

  const myPub = useMemo(() => {
    if (!state.me?.pub_key_b64) return null;
    try { return b64uDecode(state.me.pub_key_b64); }
    catch { return null; }
  }, [state.me?.pub_key_b64]);

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
        const r = await api.post<{ id: string; updated_at: number }>('/api/drafts', payload);
        setDraftId(r.id);
        setSavedAt(r.updated_at);
      } catch { /* silent */ }
    }, 1500);
    return () => clearTimeout(handle);
  }, [subject, body, to, cc, bcc, draftId, myPub]);

  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
  }, []);

  const cmd = (name: string, value?: string) => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
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
    const arg =
      name === 'formatBlock' && value
        ? `<${value.replace(/[<>]/g, '')}>`
        : value;
    try { document.execCommand(name, false, arg); } catch {}
    setBody(el.innerHTML);
  };

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
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
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
  void wrapInline;

  const insertLink = () => {
    const url = prompt('url') ?? '';
    if (!url) return;
    cmd('createLink', url);
  };
  void insertLink;

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachingFile(true);
    try {
      for (const file of Array.from(files)) {
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

  const removeHostedAttachment = (id: string) => {
    setHostedAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const removeAttachment = async (att: Attachment) => {
    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    try { await api.del(`/api/attachments/${encodeURIComponent(att.id)}`); } catch {}
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const html = body.trim().length > 0 ? body : null;
      const text = html ? htmlToPlainText(html) : '';
      const recipients = to.map((r) => r.addr);
      let bodyText = text;
      let bodyHtml = html;

      if (hostedAttachments.length > 0 && hostedCekRef.current) {
        const cek = hostedCekRef.current;
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
        const totalBytes = hostedAttachments.reduce((n, a) => n + a.plaintext_size, 0);
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

      if (secretMode) {
        if (!secretPassword) throw new Error('set a password for the secret link');
        if (secretPassword !== secretPasswordConfirm)
          throw new Error('password and confirmation do not match');
        if (recipients.length !== 1)
          throw new Error('secret links go to exactly one recipient');
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
          body: html ?? text,
          attachments: attsPlain,
          recipient: recipients[0],
          hint: secretHint || null,
          policy: secretPolicy,
        });
        const created = await api.post<{ token: string; url: string }>('/api/secret/create', payload);
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
      void invalidateContacts();
      if (draftId) {
        try { await api.del(`/api/drafts/${draftId}`); } catch {}
      }
      void deleteDraftHosted(draftId);
      hostedCekRef.current = null;
      nav(rs.replyToThreadId ? `/thread/${rs.replyToThreadId}` : '/sent', { replace: true });
    } catch (e: any) {
      setErr(e?.message || 'send failed');
    } finally {
      setBusy(false);
    }
  };

  const totalRecipients = to.length + cc.length + bcc.length;

  return (
    /* Modal-pattern layout: centered card, slides up from 8px. No scrim since
       this is a route, not a true overlay — but the visual reads as a modal. */
    <div className="flex h-full items-start justify-center overflow-y-auto bg-bg px-4 py-8">
      <form
        onSubmit={send}
        className="w-full max-w-[720px] rounded-lg border border-border bg-elev shadow-pop animate-slide-up"
      >
        {/* Modal header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h1 className="flex-1 text-[15px] font-semibold text-ink">
            {rs.replyToMessageId ? 'Reply' : 'New message'}
          </h1>
          <span className="pill">
            <LockIcon size={11} />
            End-to-end encrypted
          </span>
          <button
            type="button"
            className="btn-ghost btn btn-sm"
            onClick={() => nav(-1)}
            aria-label="Close compose"
          >
            <XIcon />
          </button>
        </div>

        {/* Fields */}
        <div className="border-b border-border">
          {/* From */}
          <div className="flex items-center gap-3 border-b border-border px-5 py-2.5">
            <label className="w-10 shrink-0 text-[12px] text-ink-faint">From</label>
            <select
              className="flex-1 bg-transparent text-[13.5px] text-ink outline-none"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              {myAddresses.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          {/* To */}
          <RecipientField
            label="To"
            value={to}
            onChange={setTo}
            required
            placeholder="recipient@example.com"
            myAddresses={myAddresses}
          />

          {/* Cc */}
          <RecipientField
            label="Cc"
            value={cc}
            onChange={setCc}
            myAddresses={myAddresses}
          />

          {/* Bcc */}
          <RecipientField
            label="Bcc"
            value={bcc}
            onChange={setBcc}
            myAddresses={myAddresses}
            autocomplete={false}
          />

          {/* Subject */}
          <div className="flex items-center gap-3 border-b border-border px-5 py-2.5">
            <label className="w-10 shrink-0 text-[12px] text-ink-faint">Subject</label>
            <input
              className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="A clear subject"
            />
          </div>
        </div>

        {/* Secret mode panel */}
        {secretMode && (
          <div className="border-b border-border bg-sunken px-5 py-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-ink">Secret link — password-gated</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setSecretMode(false)}
              >
                Cancel secret mode
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-muted">Password</span>
                <input
                  className="input font-mono"
                  type="password"
                  value={secretPassword}
                  onChange={(e) => setSecretPassword(e.target.value)}
                  autoComplete="new-password"
                  required={secretMode}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-muted">Confirm password</span>
                <input
                  className="input font-mono"
                  type="password"
                  value={secretPasswordConfirm}
                  onChange={(e) => setSecretPasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  required={secretMode}
                />
              </label>
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-[11.5px] text-ink-muted">
                  Hint <span className="text-ink-faint">(shown in the email — no secrets)</span>
                </span>
                <input
                  className="input"
                  value={secretHint}
                  onChange={(e) => setSecretHint(e.target.value)}
                  placeholder="e.g. the thing we talked about saturday"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-muted">Expires</span>
                <select
                  className="input"
                  value={secretPolicy}
                  onChange={(e) => setSecretPolicy(e.target.value as SecretPolicy)}
                >
                  <option value="one_time">One-time view</option>
                  <option value="1h">1 hour after open</option>
                  <option value="24h">24 hours after open</option>
                  <option value="14d">14 days after open</option>
                  <option value="never">Never (1 year max)</option>
                </select>
              </label>
            </div>
            <p className="mt-2 text-[11px] text-ink-muted">
              Share the password with the recipient out-of-band. It is never sent in the email.
            </p>
          </div>
        )}

        {/* Body editor */}
        <div
          ref={bodyRef}
          className="min-h-[14rem] w-full overflow-y-auto border-b border-border px-5 py-4 text-[14px] leading-relaxed text-ink focus:outline-none"
          contentEditable
          suppressContentEditableWarning
          onInput={(e) => setBody((e.currentTarget as HTMLDivElement).innerHTML)}
          data-placeholder="Write your message…"
        />

        {/* Attachment chips */}
        {(attachments.length > 0 || hostedAttachments.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="chip"
                title={`${a.mime} · ${formatBytes(a.size_bytes)} · inline MIME`}
              >
                <PaperclipIcon />
                <span className="max-w-[14rem] truncate">{a.filename}</span>
                <span className="text-ink-faint">{formatBytes(a.size_bytes)}</span>
                <button
                  type="button"
                  className="text-ink-faint transition-colors hover:text-ink"
                  onClick={() => void removeAttachment(a)}
                  aria-label={`remove ${a.filename}`}
                >
                  ×
                </button>
              </span>
            ))}
            {hostedAttachments.map((a) => (
              <span
                key={a.id}
                className="chip"
                title={`${a.mime} · ${formatBytes(a.plaintext_size)} · E2E-encrypted link in body`}
              >
                <LockIcon size={11} />
                <span className="max-w-[14rem] truncate">{a.filename}</span>
                <span className="text-ink-faint">{formatBytes(a.plaintext_size)} · link</span>
                <button
                  type="button"
                  className="text-ink-faint transition-colors hover:text-ink"
                  onClick={() => removeHostedAttachment(a.id)}
                  aria-label={`remove ${a.filename}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Formatting toolbar */}
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2">
          <FmtBtn label="B" title="Bold" bold onClick={() => cmd('bold')} />
          <FmtBtn label="I" title="Italic" italic onClick={() => cmd('italic')} />
          <FmtBtn label="S" title="Strikethrough" strike onClick={() => cmd('strikeThrough')} />
          <span className="mx-1 text-border-strong">|</span>
          <FmtBtn
            label={attachingFile ? 'Attaching…' : 'Attach'}
            title="Attach a file"
            onClick={() => fileInputRef.current?.click()}
            icon={<PaperclipIcon />}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void uploadFiles(e.target.files)}
          />
          <span className="mx-1 text-border-strong">|</span>
          <FmtBtn
            label={secretMode ? 'Secret on' : 'Secret'}
            title="Send as password-protected link"
            onClick={() => setSecretMode((v) => !v)}
            icon={<LockIcon size={12} />}
          />
          <button
            type="button"
            className="btn btn-sm btn-ghost px-2 text-[11px] text-ink-faint"
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

        {/* Error */}
        {err && (
          <div className="border-b border-danger/30 bg-danger-soft px-5 py-2.5 text-[13px] text-danger">
            {err}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-4">
          {/* Microcopy */}
          <div className="flex-1 text-[12px] text-ink-muted">
            {savedAt && <span className="mr-3 text-ink-faint">Draft saved</span>}
            {totalRecipients > 0 && (
              <span>
                <LockIcon size={11} />
                {' '}Encrypted to {totalRecipients} recipient{totalRecipients === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {/* Actions */}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => nav(-1)}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              if (!myPub) return;
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
                const r = await api.post<{ id: string; updated_at: number }>('/api/drafts', payload);
                setDraftId(r.id);
                setSavedAt(r.updated_at);
                nav('/drafts');
              } catch (e: any) {
                setErr(e?.message || 'save failed');
              }
            }}
          >
            Save draft
          </button>
          <button
            type="submit"
            className="btn btn-accent"
            disabled={busy || !from || to.length === 0}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

const BLOCK_COMMANDS = new Set([
  'insertUnorderedList',
  'insertOrderedList',
  'formatBlock',
]);

const BLOCK_TAGS = 'p, div, blockquote, ul, ol, pre, h1, h2, h3, h4, h5, h6';

function FmtBtn({
  label,
  title,
  onClick,
  bold,
  italic,
  strike,
  icon,
}: {
  label: string;
  title: string;
  onClick: () => void;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={[
        'btn btn-sm btn-ghost gap-1',
        bold ? 'font-bold' : '',
        italic ? 'italic' : '',
        strike ? 'line-through' : '',
      ].filter(Boolean).join(' ')}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline', verticalAlign: 'middle', opacity: 0.6 }}
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function htmlToPlainText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.innerText ?? div.textContent ?? '').trim();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatBytesShort(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}
