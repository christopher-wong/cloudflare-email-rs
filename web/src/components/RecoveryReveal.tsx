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
    <div className="hair-all">
      <div className="hair-b label px-3 py-2">recovery phrase</div>

      <div className="p-4">
        <p className="text-sm">
          This is the <strong>only</strong> way to recover access if you lose
          your passkey. The server doesn't have it. We won't show it again.
          Write it down or store it in a password manager <em>before</em>{' '}
          continuing.
        </p>
      </div>

      <div className="hair-t hair-b relative">
        <div className="grid grid-cols-3 gap-0">
          {words.map((w, i) => (
            <div
              key={i}
              className={
                'flex items-baseline gap-2 px-3 py-2 ' +
                (i % 3 !== 2 ? 'hair-r ' : '') +
                (i < 9 ? 'hair-b ' : '')
              }
            >
              <span className="text-mute w-6 text-right text-2xs">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="font-bold">
                {revealed ? w : '••••••'}
              </span>
            </div>
          ))}
        </div>
        {!revealed && (
          <button
            type="button"
            className="absolute inset-0 flex items-center justify-center bg-paper/95 label"
            onClick={() => setRevealed(true)}
          >
            tap to reveal ▸
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 p-3">
        <div className="flex gap-2">
          <button
            type="button"
            className="btn label"
            disabled={!revealed}
            onClick={() => navigator.clipboard.writeText(phrase)}
          >
            copy
          </button>
          <button
            type="button"
            className="btn label"
            disabled={!revealed}
            onClick={download}
          >
            download .txt
          </button>
        </div>
      </div>

      <label className="hair-t flex items-center gap-2 px-3 py-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          disabled={!revealed}
        />
        <span>
          i've saved this phrase. i understand losing it AND my passkey means
          losing access to my mail forever.
        </span>
      </label>

      <div className="hair-t flex justify-end p-3">
        <button
          type="button"
          className="btn btn-primary label"
          disabled={!acknowledged}
          onClick={onContinue}
        >
          continue to inbox ▸
        </button>
      </div>
    </div>
  );
}
