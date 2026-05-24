/**
 * Sender-side dashboard for password-protected secret links.
 *
 * Lists every link the signed-in user has created (active, opened,
 * expired, revoked) and lets them revoke or copy the share URL. The
 * underlying ciphertext and attachment bytes can only be decrypted by
 * the recipient with the password, so this page exposes nothing
 * sensitive — it's purely lifecycle management.
 */

import { useEffect, useState } from 'react';

import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';

interface SecretLinkRow {
  token: string;
  /** Null for share-only links created from /share with no email. */
  recipient_addr: string | null;
  sender_addr: string;
  hint: string | null;
  policy: 'one_time' | '1h' | '24h' | '14d' | 'never';
  created_at: number;
  expires_at: number;
  first_opened_at: number | null;
  opens_count: number;
  fail_count: number;
  revoked: boolean;
  /** Crossed the 10-failed-attempt threshold — ciphertext was wiped, R2
   *  blobs deleted. Distinct from `revoked` (manual sender action). */
  self_destructed?: boolean;
}

export default function Secrets() {
  const [rows, setRows] = useState<SecretLinkRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);

  const load = async () => {
    try {
      setRows(await api.get<SecretLinkRow[]>('/api/secret/mine'));
    } catch (e: any) {
      setErr(e?.message || 'failed to load');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (token: string) => {
    if (!confirm('Revoke this link? The recipient will not be able to open it again.')) return;
    setBusyToken(token);
    try {
      await api.post(`/api/secret/${encodeURIComponent(token)}/revoke`, {});
      await load();
    } catch (e: any) {
      setErr(e?.message || 'revoke failed');
    } finally {
      setBusyToken(null);
    }
  };

  const copyUrl = async (token: string) => {
    const url = `${window.location.origin}/s/${token}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Older browsers / non-https: fall back to a transient text selection.
      prompt('Copy link', url);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <span className="label">secret links</span>
      </Toolbar>
      {err && <div className="inv px-3 py-2 text-sm">{err}</div>}
      {!rows && <div className="text-mute p-4 text-sm">loading…</div>}
      {rows && rows.length === 0 && (
        <div className="text-mute p-4 text-sm">
          no secret links yet. enable 🔒 secret mode in compose to send one.
        </div>
      )}
      {rows && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="hair-b text-mute text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">recipient</th>
              <th className="px-3 py-2">status</th>
              <th className="px-3 py-2">policy</th>
              <th className="px-3 py-2">opens</th>
              <th className="px-3 py-2">created</th>
              <th className="px-3 py-2">expires</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const expired = r.expires_at < Date.now();
              const status = r.self_destructed
                ? 'self-destructed'
                : r.revoked
                  ? 'revoked'
                  : expired
                    ? 'expired'
                    : r.first_opened_at
                      ? 'opened'
                      : 'active';
              const dim = r.revoked || expired || r.self_destructed;
              return (
                <tr key={r.token} className={`hair-b ${dim ? 'text-mute' : ''}`}>
                  <td className="px-3 py-2 break-all">
                    {r.recipient_addr || (
                      <span className="text-mute italic">share link</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {status}
                    {r.self_destructed && (
                      <span
                        className="text-mute ml-1 text-xs"
                        title="too many failed unlocks; content deleted"
                      >
                        (10 fails)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{policyLabel(r.policy)}</td>
                  <td className="px-3 py-2">
                    {r.opens_count}
                    {r.fail_count > 0 && (
                      <span className="ml-2 text-xs text-red-600">
                        {r.fail_count} failed
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-2 text-xs">{formatDate(r.expires_at)}</td>
                  <td className="px-3 py-2 text-right">
                    {!dim && (
                      <>
                        <button
                          className="btn label py-1 px-2 text-xs"
                          onClick={() => void copyUrl(r.token)}
                          title="copy share url"
                        >
                          copy link
                        </button>
                        <button
                          className="btn label ml-1 py-1 px-2 text-xs"
                          onClick={() => void revoke(r.token)}
                          disabled={busyToken === r.token}
                        >
                          {busyToken === r.token ? '…' : 'revoke'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function policyLabel(p: SecretLinkRow['policy']): string {
  switch (p) {
    case 'one_time': return 'one-time';
    case '1h':       return '1h after open';
    case '24h':      return '24h after open';
    case '14d':      return '14d after open';
    case 'never':    return 'never (1y max)';
  }
}

function formatDate(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}
