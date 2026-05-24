/**
 * Sender-side dashboard for hosted-attachment links — the rows
 * created automatically when a regular outbound email's attachments
 * crossed the inline-MIME threshold. Lets the sender see what's still
 * live, copy a link, or revoke a download.
 */

import { useEffect, useState } from 'react';

import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';
import { openSealedBox, b64uDecode, b64uEncode } from '@/lib/crypto';
import { sessionPriv } from '@/lib/webauthn';

interface HostedFile {
  filename: string;
  mime: string;
  size: number;
  r2_key: string;
}

interface HostedRow {
  token: string;
  recipient_addrs: string[];
  subject: string | null;
  files: HostedFile[];
  total_bytes: number;
  created_at: number;
  expires_at: number;
  download_count: number;
  revoked: boolean;
  /** Server returns this only for the auth'd sender. Decrypt locally
   *  with the session priv to recover the CEK and open the viewer. */
  sender_cek_wrap_b64?: string | null;
}

export default function Hosted() {
  const [rows, setRows] = useState<HostedRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);

  const load = async () => {
    try {
      setRows(await api.get<HostedRow[]>('/api/hosted/mine'));
    } catch (e: any) {
      setErr(e?.message || 'failed to load');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (token: string) => {
    if (
      !confirm(
        'Revoke this download link? Recipients with the URL will see "files no longer available".',
      )
    )
      return;
    setBusyToken(token);
    try {
      await api.post(`/api/hosted/${encodeURIComponent(token)}/revoke`, {});
      await load();
    } catch (e: any) {
      setErr(e?.message || 'revoke failed');
    } finally {
      setBusyToken(null);
    }
  };

  /** Re-open a hosted link as the sender. Requires the row's
   *  `sender_cek_wrap_b64` (sealed-box CEK under the sender's pubkey)
   *  and the in-memory session priv. We unwrap locally and open the
   *  standard viewer with the CEK in the URL fragment. */
  const openAsSender = (row: HostedRow) => {
    if (!row.sender_cek_wrap_b64) {
      setErr(
        'this link was created before sender re-view shipped; copy the original ' +
          'URL from your sent message instead.',
      );
      return;
    }
    const priv = sessionPriv();
    if (!priv) {
      setErr('your session is locked — unlock with your passkey to re-view sent files');
      return;
    }
    try {
      const cek = openSealedBox(b64uDecode(row.sender_cek_wrap_b64), priv);
      const url = `${window.location.origin}/d/${row.token}#k=${b64uEncode(cek)}`;
      window.open(url, '_blank', 'noopener');
    } catch (e: any) {
      setErr(`could not unwrap CEK: ${e?.message || 'unknown error'}`);
    }
  };

  /** Copy the BARE token URL (without CEK). Only useful if the
   *  recipient already has the CEK from the original email — the
   *  sender themselves can't re-share via copy alone. To share again,
   *  forward the original email or use openAsSender to grab the full
   *  URL from the new tab's address bar. */
  const copyUrl = async (token: string) => {
    const url = `${window.location.origin}/d/${token}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      prompt('Copy link (no decryption key — see your sent email for the full URL)', url);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <span className="label">hosted attachments</span>
      </Toolbar>
      {err && <div className="inv px-3 py-2 text-sm">{err}</div>}
      {!rows && <div className="text-mute p-4 text-sm">loading…</div>}
      {rows && rows.length === 0 && (
        <div className="text-mute p-4 text-sm">
          no hosted attachments yet. they're created automatically when
          you send an email whose attachments exceed ~15 MiB total or any
          single file exceeds ~10 MiB.
        </div>
      )}
      {rows && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="hair-b text-mute text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">recipient(s)</th>
              <th className="px-3 py-2">subject</th>
              <th className="px-3 py-2">files</th>
              <th className="px-3 py-2">size</th>
              <th className="px-3 py-2">downloads</th>
              <th className="px-3 py-2">expires</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const expired = r.expires_at < Date.now();
              const dim = r.revoked || expired;
              return (
                <tr key={r.token} className={`hair-b ${dim ? 'text-mute' : ''}`}>
                  <td className="px-3 py-2 break-all">
                    {r.recipient_addrs[0] || '—'}
                    {r.recipient_addrs.length > 1 && (
                      <span className="text-mute text-xs">
                        {' '}
                        +{r.recipient_addrs.length - 1} more
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 break-all">
                    {r.subject || <span className="text-mute italic">(none)</span>}
                  </td>
                  <td className="px-3 py-2">{r.files.length}</td>
                  <td className="px-3 py-2 text-xs">
                    {formatBytes(r.total_bytes)}
                  </td>
                  <td className="px-3 py-2">{r.download_count}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.revoked
                      ? 'revoked'
                      : expired
                        ? 'expired'
                        : formatDate(r.expires_at)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!dim && (
                      <>
                        {r.sender_cek_wrap_b64 && (
                          <button
                            className="btn label py-1 px-2 text-xs"
                            onClick={() => openAsSender(r)}
                            title="re-open with decryption key"
                          >
                            view
                          </button>
                        )}
                        <button
                          className="btn label ml-1 py-1 px-2 text-xs"
                          onClick={() => void copyUrl(r.token)}
                          title="copy bare URL (no decryption key — see sent email)"
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024)
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}
