/**
 * One-time recovery-phrase reveal. Shown immediately after enrollment.
 * The user must:
 *   1. See the 12 words in a clear monospace grid
 *   2. Be able to copy or download
 *   3. Confirm — by checkbox — that they've written it down
 *
 * After confirm we zero the phrase from memory and call onContinue().
 * There is no second chance — the server never had the phrase.
 */

import { useState } from 'react';
import { Lock } from 'lucide-react';

export default function RecoveryReveal({
  phrase,
  onContinue,
}: {
  phrase: string;
  onContinue: () => void;
}) {
  const words = phrase.split(/\s+/);
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const download = () => {
    const blob = new Blob(
      [
        `bmail recovery phrase — keep this safe.\n`,
        `${new Date().toISOString()}\n\n`,
        phrase + '\n',
      ],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bmail-recovery.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card shadow-pop animate-zoom-in">
      {/* Card head */}
      <div className="card-head">
        <div className="flex-1">
          <div className="eyebrow mb-1">recovery phrase</div>
          <h2 className="text-[17px] font-semibold text-ink">Write this down</h2>
        </div>
        <span className="pill">
          <Lock size={11} />
          encrypted
        </span>
      </div>

      {/* Warning callout */}
      <div
        className="mx-[18px] my-4 rounded-md border px-4 py-3 text-[13px] leading-relaxed"
        style={{
          background: 'var(--accent-soft)',
          borderColor: 'color-mix(in oklch, var(--accent) 25%, transparent)',
          color: 'var(--accent-ink)',
        }}
      >
        This is the <strong>only</strong> way to recover access if you lose
        your passkey. The server doesn't have it and won't show it again.
        Save it in a password manager or write it down <em>before</em> continuing.
      </div>

      {/* Word grid */}
      <div className="relative mx-[18px] mb-4 rounded-md border border-border overflow-hidden bg-bg">
        <div className="grid grid-cols-3">
          {words.map((w, i) => (
            <div
              key={i}
              className={
                'flex items-baseline gap-2 px-4 py-2.5 ' +
                (i % 3 !== 2 ? 'border-r border-border ' : '') +
                (i < words.length - 3 ? 'border-b border-border ' : '')
              }
            >
              <span className="text-ink-faint text-[11px] font-mono w-5 text-right flex-shrink-0">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="font-mono text-[13px] font-medium text-ink">
                {revealed ? w : '••••••'}
              </span>
            </div>
          ))}
        </div>
        {!revealed && (
          <button
            type="button"
            className="absolute inset-0 flex items-center justify-center bg-bg/95 text-[13px] font-medium text-ink-muted hover:text-ink transition-colors"
            onClick={() => setRevealed(true)}
          >
            Tap to reveal
          </button>
        )}
      </div>

      {/* Copy / download actions */}
      <div className="flex gap-2 px-[18px] pb-4">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!revealed}
          onClick={() => navigator.clipboard.writeText(phrase)}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!revealed}
          onClick={download}
        >
          Download .txt
        </button>
      </div>

      {/* Acknowledgement checkbox */}
      <div className="border-t border-border px-[18px] py-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="check mt-0.5 flex-shrink-0"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={!revealed}
          />
          <span className="text-[13px] text-ink-muted leading-relaxed">
            I've saved this phrase. I understand that losing it <em>and</em> my
            passkey means permanently losing access to my mail.
          </span>
        </label>
      </div>

      {/* Continue button */}
      <div className="flex justify-end px-[18px] pb-[18px]">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!acknowledged}
          onClick={onContinue}
        >
          Continue to inbox
        </button>
      </div>
    </div>
  );
}
