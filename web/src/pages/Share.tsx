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

import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';
import * as secretLink from '@/lib/secret-link';
import type { SecretPolicy } from '@/lib/secret-link';

interface StagedFile {
  id: string;
  file: File;
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
  // Progress is reported as plaintext bytes across all attachments.
  // 0 means "not started." `progressTotal` matches the sum of file sizes.
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
      setErr('set a password');
      return;
    }
    if (password !== passwordConfirm) {
      setErr('password and confirmation do not match');
      return;
    }
    if (!subject && !body && files.length === 0) {
      setErr('add a subject, message, or at least one file');
      return;
    }
    // Pre-flight size checks — match the worker's enforced caps so the
    // user gets a clean error before the upload starts. Subject + body
    // are tiny; we just count file bytes.
    const oversized = files.find(
      (f) => f.file.size > secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES,
    );
    if (oversized) {
      setErr(
        `"${oversized.file.name}" is larger than ${formatBytes(
          secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES,
        )} per-file limit`,
      );
      return;
    }
    if (totalSize > secretLink.SECRET_MAX_LINK_BYTES) {
      setErr(
        `total of ${formatBytes(totalSize)} exceeds the ${formatBytes(
          secretLink.SECRET_MAX_LINK_BYTES,
        )} per-link limit`,
      );
      return;
    }
    setBusy(true);
    setProgressLoaded(0);
    setProgressTotal(totalSize);
    try {
      // Pass File handles directly — for any file ≥ 5 MiB plaintext the
      // chunked uploader streams 5 MiB at a time via Blob.slice, never
      // materialising the full file in JS memory.
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
        // recipient intentionally omitted — share-only link.
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
      setErr(e?.message || 'failed to create link');
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
            <button type="button" className="btn label" onClick={reset}>
              new share ▸
            </button>
          }
        >
          <span className="label">share · link ready</span>
        </Toolbar>
        <div className="mx-auto max-w-2xl space-y-4 p-6">
          <div className="hair-all p-4">
            <div className="text-mute mb-2 text-xs uppercase">link</div>
            <div className="break-all font-mono text-sm">{result.url}</div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="btn btn-primary label"
                onClick={() => void copyLink()}
              >
                {copied ? 'copied ✓' : 'copy link'}
              </button>
              <a
                href={result.url}
                target="_blank"
                rel="noreferrer noopener"
                className="btn label"
              >
                open in new tab
              </a>
            </div>
          </div>
          <p className="text-mute text-sm">
            Send the link via any channel (Signal, SMS, in person). Share the
            password <strong>separately</strong> — anyone who gets both can
            open the content. Manage and revoke from{' '}
            <a className="underline" href="/secrets">/secrets</a>.
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
            className="btn btn-primary label"
            disabled={busy || !password}
          >
            {busy ? 'encrypting…' : 'create link ▸'}
          </button>
        }
      >
        <span className="label">share · password-protected</span>
      </Toolbar>

      <div className="mx-auto w-full max-w-2xl space-y-3 p-4">
        <p className="text-mute text-sm">
          Encrypts your message and files in your browser, gives you a URL
          anyone can open with the password. No email is sent — the server
          never sees your password or the contents.
        </p>

        <div className="hair-all">
          <div className="field">
            <div className="field-label">subject</div>
            <input
              className="field-value w-full border-0"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="(optional)"
            />
          </div>
          <div className="hair-t p-3">
            <textarea
              className="block min-h-[10rem] w-full resize-y border-0 text-sm focus:outline-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="message… (optional)"
            />
          </div>
        </div>

        {/* Multi-file drop zone + picker. Lets the user dump a folder of
            files in at once, see each one, and remove individuals before
            committing. */}
        <div
          className={
            'hair-all p-4 text-sm transition-colors ' +
            (dragging ? 'bg-[var(--bg-mute,#f5f5f5)]' : '')
          }
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-mute">
              drop files here, or{' '}
              <button
                type="button"
                className="underline"
                onClick={() => fileInputRef.current?.click()}
              >
                browse
              </button>
            </span>
            {files.length > 0 ? (
              <span
                className={
                  'text-xs ' +
                  (totalSize > secretLink.SECRET_MAX_LINK_BYTES
                    ? 'text-red-600'
                    : 'text-mute')
                }
              >
                {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
                {formatBytes(totalSize)} / {formatBytes(secretLink.SECRET_MAX_LINK_BYTES)}
              </span>
            ) : (
              <span className="text-mute text-xs">
                up to {formatBytes(secretLink.SECRET_MAX_LINK_BYTES)} per link,{' '}
                {formatBytes(secretLink.SECRET_MAX_PER_ATTACHMENT_BYTES)} per file
              </span>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={onPick}
          />
          {files.length > 0 && (
            <ul className="mt-3 space-y-1">
              {files.map((f) => (
                <li
                  key={f.id}
                  className="hair-all flex items-center justify-between gap-3 px-2 py-1 text-xs"
                >
                  <span className="truncate" title={f.file.name}>
                    {f.file.name}
                  </span>
                  <span className="text-mute flex items-center gap-2">
                    <span>{formatBytes(f.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(f.id)}
                      className="hover:text-black"
                      title="remove"
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="hair-all p-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-mute text-xs">password</span>
              <input
                className="border px-2 py-1 font-mono"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-mute text-xs">confirm password</span>
              <input
                className="border px-2 py-1 font-mono"
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-mute text-xs">
                hint{' '}
                <span className="text-[10px]">
                  (shown above the password prompt — no secrets)
                </span>
              </span>
              <input
                className="border px-2 py-1"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                placeholder="e.g. our shared travel doc password"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-mute text-xs">expires</span>
              <select
                className="border px-2 py-1"
                value={policy}
                onChange={(e) => setPolicy(e.target.value as SecretPolicy)}
              >
                <option value="one_time">one-time view</option>
                <option value="1h">1 hour after open</option>
                <option value="24h">24 hours after open</option>
                <option value="14d">14 days after open</option>
                <option value="never">never (1 year max)</option>
              </select>
            </label>
          </div>
        </div>

        {busy && progressTotal > 0 && (
          <div className="hair-all px-3 py-2 text-xs">
            <div className="mb-1 flex justify-between">
              <span>encrypting + uploading…</span>
              <span className="text-mute">
                {formatBytes(progressLoaded)} / {formatBytes(progressTotal)} (
                {((progressLoaded / progressTotal) * 100).toFixed(0)}%)
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden border border-black">
              <div
                className="h-full bg-black"
                style={{
                  width: `${(progressLoaded / progressTotal) * 100}%`,
                  transition: 'width 120ms linear',
                }}
              />
            </div>
          </div>
        )}

        {err && <div className="inv px-3 py-2 text-sm">{err}</div>}
      </div>
    </form>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
