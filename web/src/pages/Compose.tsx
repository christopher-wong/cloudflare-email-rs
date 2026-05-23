/**
 * Compose / reply. The plaintext goes to the server during send (it must,
 * for SMTP delivery). Drafts, however, are encrypted client-side to the
 * user's own pubkey before upload — the server only stores ciphertext for
 * drafts at rest.
 */

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';
import { useApp } from '@/lib/store';
import { b64uDecode, b64uEncode, sealToSelf, utf8 } from '@/lib/crypto';

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

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/messages/send', {
        from,
        from_name: state.me?.display_name || null,
        to: splitAddrs(to),
        cc: splitAddrs(cc),
        bcc: splitAddrs(bcc),
        subject,
        text: body,
        html: null,
        in_reply_to: rs.messageId ?? null,
        references: rs.references ?? null,
        attachment_r2_keys: [],
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

      <textarea
        className="flex-1 w-full resize-none border-0 p-4 leading-relaxed"
        placeholder="message…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      {err && <div className="hair-t inv px-3 py-2 text-sm">{err}</div>}
    </form>
  );
}

function splitAddrs(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
