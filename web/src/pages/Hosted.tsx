/**
 * Sender-side dashboard for hosted-attachment links — the rows
 * created automatically when a regular outbound email's attachments
 * crossed the inline-MIME threshold. Lets the sender see what's still
 * live, copy a link, or revoke a download.
 */

import { useEffect, useState } from 'react';

import EmptyState from '@/components/EmptyState';
import Loader from '@/components/Loader';
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

function PaperclipIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

type RowStatus = 'revoked' | 'expired' | 'active';

function StatusPill({ status }: { status: RowStatus }) {
  const classes: Record<RowStatus, string> = {
    active:  'status status-on',
    expired: 'status status-err',
    revoked: 'status',
  };
  const labels: Record<RowStatus, string> = {
    active:  'active',
    expired: 'expired',
    revoked: 'revoked',
  };
  return (
    <span className={classes[status]}>
      <span className="dot" />
      {labels[status]}
    </span>
  );
}

export default function Hosted() {
  const [rows, setRows] = useState<HostedRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      setRows(await api.get<HostedRow[]>('/api/hosted/mine'));
    } catch (e: any) {
      setErr(e?.message || 'Failed to load.');
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
      setErr(e?.message || 'Revoke failed.');
    } finally {
      setBusyToken(null);
    }
  };

  const openAsSender = (row: HostedRow) => {
    if (!row.sender_cek_wrap_b64) {
      setErr(
        'This link was created before sender re-view shipped; copy the original URL from your sent message instead.',
      );
      return;
    }
    const priv = sessionPriv();
    if (!priv) {
      setErr('Your session is locked — unlock with your passkey to re-view sent files.');
      return;
    }
    try {
      const cek = openSealedBox(b64uDecode(row.sender_cek_wrap_b64), priv);
      const url = `${window.location.origin}/d/${row.token}#k=${b64uEncode(cek)}`;
      window.open(url, '_blank', 'noopener');
    } catch (e: any) {
      setErr(`Could not unwrap CEK: ${e?.message || 'unknown error'}`);
    }
  };

  const copyUrl = async (token: string) => {
    const url = `${window.location.origin}/d/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 1500);
    } catch {
      prompt('Copy link (no decryption key — see your sent email for the full URL)', url);
    }
  };

  const filtered = rows
    ? rows.filter((r) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          r.subject?.toLowerCase().includes(q) ||
          r.recipient_addrs.some((a) => a.toLowerCase().includes(q)) ||
          r.files.some((f) => f.filename.toLowerCase().includes(q))
        );
      })
    : null;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <span className="eyebrow">share</span>
        <span className="text-ink-faint text-[13px]">/</span>
        <span className="text-[26px] font-semibold tracking-tight text-ink">Hosted attachments</span>
      </Toolbar>

      {/* Error notice */}
      {err && (
        <div className="mx-5 mt-4 rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {err}
        </div>
      )}

      {/* Loading */}
      {!rows && !err && (
        <div className="flex flex-1 items-center justify-center">
          <Loader />
        </div>
      )}

      {/* Empty state */}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={<PaperclipIcon />}
          title="No hosted attachments"
          hint="Hosted download links are created automatically when outbound attachments exceed the inline-MIME threshold (~15 MiB total or ~10 MiB per file)."
        />
      )}

      {/* Data table */}
      {rows && rows.length > 0 && (
        <div className="mx-5 my-5 space-y-4">
          {/* Search toolbar */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-xs">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                className="input pl-8"
                placeholder="Search by recipient, subject, or filename…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {search && (
              <span className="text-[12.5px] text-ink-muted">
                {filtered?.length ?? 0} of {rows.length} shown
              </span>
            )}
          </div>

          <div className="card overflow-hidden">
            {/* Table header */}
            <div
              className="grid items-center gap-3.5 border-b border-border bg-bg px-[18px] py-2.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-faint"
              style={{ gridTemplateColumns: '1.4fr 1.2fr 0.8fr 0.5fr 0.6fr 1fr auto' }}
            >
              <div>Recipient</div>
              <div>Subject / files</div>
              <div>Status</div>
              <div className="text-right">Downloads</div>
              <div>Size</div>
              <div>Expires</div>
              <div />
            </div>

            {filtered && filtered.length === 0 ? (
              <div className="px-[18px] py-8 text-center text-[13.5px] text-ink-muted">
                No results for &ldquo;{search}&rdquo;
              </div>
            ) : (
              (filtered ?? []).map((r) => {
                const expired = r.expires_at < Date.now();
                const status: RowStatus = r.revoked ? 'revoked' : expired ? 'expired' : 'active';
                const dim = r.revoked || expired;

                return (
                  <div
                    key={r.token}
                    className={
                      'grid items-center gap-3.5 border-b border-border px-[18px] py-3 last:border-0 hover:bg-hover transition-colors ' +
                      (dim ? 'opacity-60' : '')
                    }
                    style={{ gridTemplateColumns: '1.4fr 1.2fr 0.8fr 0.5fr 0.6fr 1fr auto' }}
                  >
                    {/* Recipient */}
                    <div className="min-w-0">
                      <span className="block truncate font-mono text-[12.5px] text-ink" title={r.recipient_addrs[0]}>
                        {r.recipient_addrs[0] || '—'}
                      </span>
                      {r.recipient_addrs.length > 1 && (
                        <span className="text-[11.5px] text-ink-faint">
                          +{r.recipient_addrs.length - 1} more
                        </span>
                      )}
                    </div>

                    {/* Subject / files */}
                    <div className="min-w-0">
                      {r.subject ? (
                        <span className="block truncate text-[13px] text-ink" title={r.subject}>
                          {r.subject}
                        </span>
                      ) : (
                        <span className="text-[13px] text-ink-muted italic">(no subject)</span>
                      )}
                      <span className="block truncate font-mono text-[11.5px] text-ink-faint">
                        {r.files.length} file{r.files.length === 1 ? '' : 's'} ·{' '}
                        {r.files.map((f) => f.filename).slice(0, 2).join(', ')}
                        {r.files.length > 2 ? '…' : ''}
                      </span>
                    </div>

                    {/* Status */}
                    <div>
                      <StatusPill status={status} />
                    </div>

                    {/* Downloads */}
                    <div className="text-right">
                      <span className="tnum text-[13px] text-ink">{r.download_count}</span>
                    </div>

                    {/* Size */}
                    <div className="tnum text-[12px] text-ink-muted">
                      {formatBytes(r.total_bytes)}
                    </div>

                    {/* Expires */}
                    <div className="font-mono text-[12px] text-ink-muted">
                      {r.revoked ? 'Revoked' : expired ? 'Expired' : formatDate(r.expires_at)}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5">
                      {!dim && (
                        <>
                          {r.sender_cek_wrap_b64 && (
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={() => openAsSender(r)}
                              title="Re-open with decryption key"
                            >
                              View
                            </button>
                          )}
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => void copyUrl(r.token)}
                            title="Copy bare URL (no decryption key — see sent email)"
                          >
                            {copiedToken === r.token ? 'Copied' : 'Copy link'}
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => void revoke(r.token)}
                            disabled={busyToken === r.token}
                          >
                            {busyToken === r.token ? '…' : 'Revoke'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
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
