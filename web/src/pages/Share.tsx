/**
 * Standalone secret-link generator. No email involved — the user composes
 * a message and/or picks files, sets a password, and gets back a
 * `https://<host>/s/<token>` URL they can hand to anyone.
 *
 * All encryption happens client-side via the same primitives used by the
 * Compose secret-mode path (`web/src/lib/secret-link.ts`). The server
 * sees ciphertext + a one-way password check value only.
 */

import { ChangeEvent, DragEvent, FormEvent, useRef, useState } from 'react';

import EmptyState from '@/components/EmptyState';
import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';
import * as secretLink from '@/lib/secret-link';
import type { SecretPolicy } from '@/lib/secret-link';

interface StagedFile {
  id: string;
  file: File;
}

// Lock glyph for inline encryption whisper
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

function LinkIcon() {
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

export default function Share() {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [hint, setHint] = useState('');
  const [policy, setPolicy] = useState<SecretPolicy>('14d');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ token: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [progressLoaded, setProgressLoaded] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);

  const totalSize = files.reduce((n, f) => n + f.file.size, 0);

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    const items: File[] = Array.from(incoming as ArrayLike<File>);
    if (items.length === 0) return;
    setFiles((prev) => [
      ...prev,
      ...items.map((f) => ({ id: crypto.randomUUID(), file: f })),
    ]);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const reset = () => {
    setSubject('');
    setBody('');
    setFiles([]);
    setPassword('');
    setPasswordConfirm('');
    setHint('');
    setPolicy('14d');
    setResult(null);
    setErr(null);
    setCopied(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!password) {
      setErr('Set a password.');
      return;
    }
    if (password !== passwordConfirm) {
      setErr('Password and confirmation do not match.');
      return;
    }
    if (!subject && !body && files.length === 0) {
      setErr('Add a subject, message, or at least one file.');
      return;
    }
    const oversized = files.find(
      (f) => f.file.size > secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES,
    );
    if (oversized) {
      setErr(
        `"${oversized.file.name}" exceeds the ${formatBytes(
          secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES,
        )} per-file limit.`,
      );
      return;
    }
    if (totalSize > secretLink.SECRET_MAX_LINK_BYTES) {
      setErr(
        `Total of ${formatBytes(totalSize)} exceeds the ${formatBytes(
          secretLink.SECRET_MAX_LINK_BYTES,
        )} per-link limit.`,
      );
      return;
    }
    setBusy(true);
    setProgressLoaded(0);
    setProgressTotal(totalSize);
    try {
      const inputs: secretLink.SecretAttachmentInput[] = files.map((sf) => ({
        filename: sf.file.name,
        mime: sf.file.type || 'application/octet-stream',
        file: sf.file,
      }));
      const payload = await secretLink.prepareCreateRequest({
        password,
        subject,
        body,
        attachments: inputs,
        hint: hint || null,
        policy,
        onProgress: (loaded, total) => {
          setProgressLoaded(loaded);
          setProgressTotal(total);
        },
      });
      const created = await api.post<{ token: string; url: string }>(
        '/api/secret/create',
        payload,
      );
      setResult(created);
    } catch (e: any) {
      setErr(e?.message || 'Failed to create link.');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('Copy link', result.url);
    }
  };

  if (result) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar
          right={
            <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
              Create another
            </button>
          }
        >
          <span className="eyebrow">share</span>
          <span className="text-ink-faint text-[13px]">/</span>
          <span className="text-[13.5px] font-medium text-ink">Link ready</span>
        </Toolbar>

        <div className="mx-auto w-full max-w-2xl space-y-4 px-5 py-6">
          <div className="card">
            <div className="card-head">
              <div>
                <div className="text-[13px] font-semibold text-ink">Your secret link</div>
                <div className="text-[12.5px] text-ink-muted">
                  Share the link and password separately.
                </div>
              </div>
            </div>
            <div className="card-body space-y-3">
              <div className="rounded-md border border-border bg-sunken px-3 py-2">
                <div className="break-all font-mono text-[12.5px] text-ink">{result.url}</div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void copyLink()}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="btn"
                >
                  Open in new tab
                </a>
              </div>
            </div>
          </div>

          <p className="text-[13.5px] text-ink-muted">
            Send the link via any channel (Signal, SMS, in person). Share the
            password <strong className="font-medium text-ink">separately</strong> — anyone
            who gets both can open the content. Manage and revoke from{' '}
            <a className="link" href="/secrets">
              secret links
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <Toolbar
        right={
          <button
            type="submit"
            className="btn btn-accent"
            disabled={busy || !password}
          >
            <LockIcon />
            {busy ? 'Encrypting…' : 'Create link'}
          </button>
        }
      >
        <span className="eyebrow">share</span>
      </Toolbar>

      <div className="mx-auto w-full max-w-2xl space-y-4 px-5 py-6">
        {/* Page header */}
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">Secret links</h1>
          <p className="mt-1 text-[13.5px] text-ink-muted">
            Encrypt a message or files in your browser and share a password-protected link —
            the server never sees your password or the contents.
          </p>
        </div>

        {/* Composition card */}
        <div className="card">
          <div className="card-head">
            <div className="text-[13px] font-semibold text-ink">Message</div>
          </div>

          {/* Subject row */}
          <div className="field-row">
            <label className="field-label" htmlFor="share-subject">
              Subject
            </label>
            <input
              id="share-subject"
              className="input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="A clear subject."
            />
          </div>

          {/* Body row */}
          <div className="field-row" style={{ alignItems: 'flex-start', paddingTop: '14px', paddingBottom: '14px' }}>
            <label className="field-label pt-1" htmlFor="share-body">
              Body
            </label>
            <textarea
              id="share-body"
              className="input"
              style={{ minHeight: '8rem', resize: 'vertical' }}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Your message…"
            />
          </div>

          {/* Password row */}
          <div className="field-row">
            <label className="field-label" htmlFor="share-password">
              Password
            </label>
            <input
              id="share-password"
              className="input font-mono"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Passphrase the recipient must enter"
              required
            />
          </div>

          {/* Confirm password row */}
          <div className="field-row">
            <label className="field-label" htmlFor="share-password-confirm">
              Confirm
            </label>
            <input
              id="share-password-confirm"
              className="input font-mono"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              autoComplete="new-password"
              placeholder="Repeat the passphrase"
              required
            />
          </div>

          {/* Hint row */}
          <div className="field-row">
            <label className="field-label" htmlFor="share-hint">
              Hint
              <span className="block text-[11px] text-ink-faint font-normal">
                Shown above prompt, not secret
              </span>
            </label>
            <input
              id="share-hint"
              className="input"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="e.g. our shared travel doc password"
            />
          </div>

          {/* Expiry row */}
          <div className="field-row">
            <label className="field-label" htmlFor="share-expiry">
              Expires
            </label>
            <select
              id="share-expiry"
              className="input"
              style={{
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236B6B66' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 10px center',
                backgroundSize: '12px',
                paddingRight: '32px',
              }}
              value={policy}
              onChange={(e) => setPolicy(e.target.value as SecretPolicy)}
            >
              <option value="one_time">One-time view</option>
              <option value="1h">1 hour after open</option>
              <option value="24h">24 hours after open</option>
              <option value="14d">14 days after open</option>
              <option value="never">Never (1 year max)</option>
            </select>
          </div>

          {/* Footer: encryption whisper */}
          <div className="flex items-center gap-3 px-[18px] py-3 border-t border-border">
            <span className="pill">
              <LockIcon />
              encrypted
            </span>
            <span className="text-[12px] text-ink-muted">
              Password is hashed with Argon2id in your browser — the server never sees it.
            </span>
          </div>
        </div>

        {/* File attachment zone */}
        <div className="card">
          <div className="card-head">
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-ink">Attachments</div>
              <div className="text-[12.5px] text-ink-muted">
                Up to {formatBytes(secretLink.SECRET_MAX_LINK_BYTES)} per link,{' '}
                {formatBytes(secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES)} per file
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Add files
            </button>
          </div>

          <div
            className={
              'card-body transition-colors ' +
              (dragging ? 'bg-hover' : '')
            }
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={onPick}
            />

            {files.length === 0 ? (
              <EmptyState
                title="No files attached"
                hint={
                  <>
                    Drop files here or{' '}
                    <button
                      type="button"
                      className="link"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      browse
                    </button>{' '}
                    to add them.
                  </>
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {files.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0 truncate font-mono text-[12.5px] text-ink" title={f.file.name}>
                      {f.file.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="tnum text-[12px] text-ink-muted">
                        {formatBytes(f.file.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(f.id)}
                        className="btn btn-sm btn-ghost text-ink-faint hover:text-danger"
                        title="Remove"
                        aria-label={`Remove ${f.file.name}`}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {files.length > 0 && (
              <div className="mt-3 flex justify-between text-[12px]">
                <span className="text-ink-muted">
                  {files.length} file{files.length === 1 ? '' : 's'}
                </span>
                <span
                  className={
                    totalSize > secretLink.SECRET_MAX_LINK_BYTES
                      ? 'text-danger font-medium'
                      : 'text-ink-muted'
                  }
                >
                  {formatBytes(totalSize)} / {formatBytes(secretLink.SECRET_MAX_LINK_BYTES)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Upload progress */}
        {busy && progressTotal > 0 && (
          <div className="card">
            <div className="card-body space-y-2">
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="text-ink-muted">Encrypting and uploading…</span>
                <span className="tnum text-ink-faint">
                  {formatBytes(progressLoaded)} / {formatBytes(progressTotal)} (
                  {((progressLoaded / progressTotal) * 100).toFixed(0)}%)
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-sunken">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{
                    width: `${(progressLoaded / progressTotal) * 100}%`,
                    transition: 'width 120ms linear',
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Error notice */}
        {err && (
          <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {err}
          </div>
        )}
      </div>
    </form>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
