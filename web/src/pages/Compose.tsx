/**
 * Compose / reply. The plaintext goes to the server during send (it must,
 * for SMTP delivery). Drafts, however, are encrypted client-side to the
 * user's own pubkey before upload — the server only stores ciphertext for
 * drafts at rest.
 */

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { marked } from 'marked';

import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';
import { useApp } from '@/lib/store';
import { b64uDecode, b64uEncode, sealToSelf, utf8 } from '@/lib/crypto';

interface Attachment {
  id: string;
  r2_key: string;
  filename: string;
  filename_ct_b64: string | null;
  mime: string;
  size_bytes: number;
}

interface ReplyState {
  replyToMessageId?: string;
  replyToThreadId?: string;
  messageId?: string;
  references?: string;
  to?: string[];
  subject?: string;
}

export default function Compose() {
  const nav = useNavigate();
  const location = useLocation();
  const { state } = useApp();
  const rs = (location.state ?? {}) as ReplyState;

  const myAddresses = state.me?.addresses ?? [];
  const [from, setFrom] = useState(myAddresses[0] ?? '');
  const [to, setTo] = useState((rs.to ?? []).join(', '));
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(rs.subject ?? '');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachingFile, setAttachingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
          to_addrs: splitAddrs(to),
          cc_addrs: splitAddrs(cc),
          bcc_addrs: splitAddrs(bcc),
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

  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Wrap (or unwrap) the current selection in the textarea with the given
   * delimiter pair. If nothing's selected, drop a placeholder so the user
   * sees the syntax appear and can type the content. Re-focuses afterward
   * so keyboard flow keeps going. Uses textarea.setRangeText so undo/redo
   * stay native.
   */
  const wrapSelection = (open: string, close: string, placeholder = 'text') => {
    const el = bodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = el.value;
    const selected = value.slice(start, end) || placeholder;
    const replacement = `${open}${selected}${close}`;
    el.setRangeText(replacement, start, end, 'end');
    setBody(el.value);
    // Reposition cursor inside the wrap so the user can keep typing.
    const newPos = start + open.length + selected.length;
    el.setSelectionRange(newPos, newPos);
    el.focus();
  };

  /**
   * Prefix every line in the current selection (or the current line) with
   * a marker — used for lists, blockquotes, and headings. Markdown line
   * prefixes are line-oriented, so we operate over whole lines, not the
   * raw range.
   */
  const prefixLines = (marker: string | ((n: number) => string)) => {
    const el = bodyRef.current;
    if (!el) return;
    const value = el.value;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', end);
    const sliceEnd = lineEnd === -1 ? value.length : lineEnd;
    const lines = value.slice(lineStart, sliceEnd).split('\n');
    const updated = lines
      .map((l, i) => (typeof marker === 'string' ? marker : marker(i + 1)) + l)
      .join('\n');
    el.setRangeText(updated, lineStart, sliceEnd, 'end');
    setBody(el.value);
    el.focus();
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
        const buf = new Uint8Array(await file.arrayBuffer());
        const filenameCt = myPub
          ? b64uEncode(sealToSelf(utf8(file.name), myPub))
          : null;
        const qs = new URLSearchParams({ mime: file.type || 'application/octet-stream' });
        if (filenameCt) qs.set('filename_ct_b64', filenameCt);
        const resp = await api.rawFetch(
          'POST',
          `/api/attachments?${qs.toString()}`,
          buf,
        );
        if (!resp.ok) throw new Error(`upload failed (${resp.status})`);
        const r = (await resp.json()) as {
          id: string;
          r2_key: string;
          size_bytes: number;
          mime: string;
        };
        setAttachments((prev) => [
          ...prev,
          {
            id: r.id,
            r2_key: r.r2_key,
            filename: file.name,
            filename_ct_b64: filenameCt,
            mime: r.mime,
            size_bytes: r.size_bytes,
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

  const removeAttachment = async (att: Attachment) => {
    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    try { await api.del(`/api/attachments/${encodeURIComponent(att.id)}`); } catch { /* ignore */ }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // The text part stays the raw markdown source so plain-text clients
      // (and our own mailbox copy) get readable content. The html part is
      // the rendered markdown so HTML-capable clients get formatting. We
      // don't sanitize because the rendered output goes to recipients'
      // mail clients, which all sandbox HTML themselves — and the source
      // is the user's own text, no XSS concern for us.
      const html =
        body.trim().length > 0
          ? marked.parse(body, { async: false, gfm: true, breaks: true }) as string
          : null;
      await api.post('/api/messages/send', {
        from,
        from_name: state.me?.display_name || null,
        to: splitAddrs(to),
        cc: splitAddrs(cc),
        bcc: splitAddrs(bcc),
        subject,
        text: body,
        html,
        in_reply_to: rs.messageId ?? null,
        references: rs.references ?? null,
        attachments: attachments.map((a) => ({
          r2_key: a.r2_key,
          filename: a.filename,
          filename_ct_b64: a.filename_ct_b64,
          mime: a.mime,
        })),
      });
      if (draftId) {
        try { await api.del(`/api/drafts/${draftId}`); } catch {}
      }
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
        <div className="field">
          <div className="field-label">to</div>
          <input
            className="field-value w-full border-0"
            placeholder="someone@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <div className="field-label">cc</div>
          <input
            className="field-value w-full border-0"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          />
        </div>
        <div className="field">
          <div className="field-label">bcc</div>
          <input
            className="field-value w-full border-0"
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
          />
        </div>
        <div className="field">
          <div className="field-label">subject</div>
          <input
            className="field-value w-full border-0"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      </div>

      <div className="hair-b flex flex-wrap items-center gap-1 px-2 py-1">
        <FmtBtn label="B" title="bold (Markdown: **text**)" bold
          onClick={() => wrapSelection('**', '**', 'bold')} />
        <FmtBtn label="I" title="italic (Markdown: *text*)" italic
          onClick={() => wrapSelection('*', '*', 'italic')} />
        <FmtBtn label="S" title="strikethrough (Markdown: ~~text~~)" strike
          onClick={() => wrapSelection('~~', '~~', 'strike')} />
        <span className="text-mute mx-1">|</span>
        <FmtBtn label="• list" title="bulleted list" onClick={() => prefixLines('- ')} />
        <FmtBtn label="1. list" title="numbered list"
          onClick={() => prefixLines((n) => `${n}. `)} />
        <FmtBtn label="❝" title="blockquote" onClick={() => prefixLines('> ')} />
        <span className="text-mute mx-1">|</span>
        <FmtBtn label="‹ code ›" title="inline code (Markdown: `code`)"
          onClick={() => wrapSelection('`', '`', 'code')} />
        <FmtBtn label="block" title="code block (Markdown: ```)"
          onClick={() => wrapSelection('\n```\n', '\n```\n', 'code')} />
        <FmtBtn label="link" title="link (Markdown: [text](url))"
          onClick={() => {
            const url = prompt('url') ?? '';
            if (!url) return;
            wrapSelection('[', `](${url})`, 'text');
          }} />
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
        <span className="ml-auto text-mute text-2xs">markdown</span>
      </div>

      {attachments.length > 0 && (
        <div className="hair-b flex flex-wrap items-center gap-2 px-3 py-2">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="hair-all flex items-center gap-2 px-2 py-1 text-xs"
              title={`${a.mime} · ${formatBytes(a.size_bytes)}`}
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
        </div>
      )}

      <textarea
        ref={bodyRef}
        className="flex-1 w-full resize-none border-0 p-4 leading-relaxed"
        placeholder="message… (markdown supported)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      {err && <div className="hair-t inv px-3 py-2 text-sm">{err}</div>}
    </form>
  );
}

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function splitAddrs(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
