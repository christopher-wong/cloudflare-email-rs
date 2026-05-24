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

import EmptyState from '@/components/EmptyState';
import Loader from '@/components/Loader';
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

// Lock glyph for status column
function LockIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" />
    </svg>
  );
}

function LinkListIcon() {
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
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

type RowStatus = 'self-destructed' | 'revoked' | 'expired' | 'opened' | 'active';

function StatusPill({ status }: { status: RowStatus }) {
  const variants: Record<RowStatus, string> = {
    opened:          'status status-on',
    active:          'status status-wait',
    expired:         'status status-err',
    revoked:         'status',
    'self-destructed': 'status status-err',
  };
  const labels: Record<RowStatus, string> = {
    opened:          'opened',
    active:          'pending',
    expired:         'expired',
    revoked:         'revoked',
    'self-destructed': 'self-destructed',
  };
  return (
    <span className={variants[status]}>
      <span className="dot" />
      {labels[status]}
    </span>
  );
}

export default function Secrets() {
  const [rows, setRows] = useState<SecretLinkRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const load = async () => {
    try {
      setRows(await api.get<SecretLinkRow[]>('/api/secret/mine'));
    } catch (e: any) {
      setErr(e?.message || 'Failed to load.');
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
      setErr(e?.message || 'Revoke failed.');
    } finally {
      setBusyToken(null);
    }
  };

  const copyUrl = async (token: string) => {
    const url = `${window.location.origin}/s/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 1500);
    } catch {
      prompt('Copy link', url);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        right={
          <a href="/share" className="btn btn-primary">
            + Create link
          </a>
        }
      >
        <span className="eyebrow">share</span>
        <span className="text-ink-faint text-[13px]">/</span>
        <span className="text-[26px] font-semibold tracking-tight text-ink">Secret links</span>
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
          icon={<LinkListIcon />}
          title="No secret links yet"
          hint="Create a password-protected link to share a message or files securely."
          action={
            <a href="/share" className="btn btn-primary">
              Create your first link
            </a>
          }
        />
      )}

      {/* Data table */}
      {rows && rows.length > 0 && (
        <div className="mx-5 my-5">
          {/* Page heading above table */}
          <div className="mb-4">
            <p className="text-[13.5px] text-ink-muted">
              {rows.length} link{rows.length === 1 ? '' : 's'} — manage access and revoke from here.
            </p>
          </div>

          <div className="card overflow-hidden">
            {/* Table header */}
            <div className="grid items-center gap-3.5 border-b border-border bg-bg px-[18px] py-2.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-faint"
              style={{ gridTemplateColumns: '1.6fr 0.9fr 1fr 0.5fr 1.1fr auto' }}
            >
              <div>Recipient / Subject</div>
              <div>Status</div>
              <div>Policy</div>
              <div className="text-right">Opens</div>
              <div>Created</div>
              <div />
            </div>

            {/* Table rows */}
            {rows.map((r) => {
              const expired = r.expires_at < Date.now();
              const status: RowStatus = r.self_destructed
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
                <div
                  key={r.token}
                  className={
                    'grid items-center gap-3.5 border-b border-border px-[18px] py-3 last:border-0 hover:bg-hover transition-colors ' +
                    (dim ? 'opacity-60' : '')
                  }
                  style={{ gridTemplateColumns: '1.6fr 0.9fr 1fr 0.5fr 1.1fr auto' }}
                >
                  {/* Recipient / type */}
                  <div className="min-w-0">
                    {r.recipient_addr ? (
                      <span className="block truncate font-mono text-[12.5px] text-ink" title={r.recipient_addr}>
                        {r.recipient_addr}
                      </span>
                    ) : (
                      <span className="text-[13px] text-ink-muted italic">Share link</span>
                    )}
                    {r.hint && (
                      <span className="block truncate text-[11.5px] text-ink-faint" title={r.hint}>
                        hint: {r.hint}
                      </span>
                    )}
                  </div>

                  {/* Status */}
                  <div className="flex items-center gap-1.5">
                    <StatusPill status={status} />
                    {status === 'active' && (
                      <LockIcon />
                    )}
                  </div>

                  {/* Policy */}
                  <div className="font-mono text-[12px] text-ink-muted">
                    {policyLabel(r.policy)}
                  </div>

                  {/* Opens */}
                  <div className="text-right">
                    <span className="tnum text-[13px] text-ink">{r.opens_count}</span>
                    {r.fail_count > 0 && (
                      <span className="ml-1.5 text-[11px] text-danger">
                        {r.fail_count} failed
                      </span>
                    )}
                  </div>

                  {/* Created date */}
                  <div className="font-mono text-[12px] text-ink-muted">
                    {formatDate(r.created_at)}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5">
                    {!dim && (
                      <>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => void copyUrl(r.token)}
                          title="Copy share URL"
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
            })}
          </div>
        </div>
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
