/**
 * Initial-letter avatar. Deterministic: same input → same color so a
 * sender's row always looks the same across reloads and tabs. We hash
 * the address to one of 12 hand-picked black/white-compatible accent
 * tones so we don't undercut the rest of the chrome's brutalist B&W
 * palette.
 */

const PALETTE = [
  '#000000', // pure black — for cases like our own outbound
  '#222',
  '#444',
  '#1f3a8a', // muted navy
  '#3b2e5f', // muted plum
  '#5b3a29', // burnt sienna
  '#5e4d1e', // amber-brown
  '#1f4d36', // pine
  '#3a4d52',
  '#4d2a3a',
  '#6b3b1f',
  '#2d3a52',
] as const;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initial(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '·';
  // For an email address we want the first character of the local part,
  // not the @. Same logic falls through for plain names.
  const first = trimmed[0];
  return first.toUpperCase();
}

/**
 * Initial-letter avatar with an optional "tap to select" affordance.
 *
 * When `onToggle` is provided, the avatar renders as a button: on hover
 * it shows a checkbox-style outline overlay, and when `selected` is true
 * the letter is swapped for a check on an inverted background. This
 * collapses the per-row checkbox column into the avatar slot — same
 * pixel, two meanings, depending on whether the user is in a multi-select
 * mood.
 */
export default function Avatar({
  seed,
  size = 36,
  selected = false,
  onToggle,
}: {
  seed: string;
  size?: number;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const bg = PALETTE[hash(seed) % PALETTE.length];
  const fontSize = Math.round(size * 0.45);

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    background: selected ? '#000' : bg,
    color: '#fff',
    fontSize,
    lineHeight: 1,
    border: '1px solid #000',
  };

  if (!onToggle) {
    return (
      <div
        aria-hidden
        className="flex shrink-0 items-center justify-center font-bold"
        style={baseStyle}
      >
        {initial(seed)}
      </div>
    );
  }

  // Interactive mode: button with a hover hint and a selected state. We
  // stop event propagation so the surrounding row's onClick (navigate to
  // thread) doesn't fire when toggling selection.
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={selected}
      aria-label={selected ? 'deselect thread' : 'select thread'}
      title={selected ? 'deselect' : 'select'}
      className="group relative flex shrink-0 items-center justify-center font-bold"
      style={baseStyle}
    >
      {selected ? (
        <CheckIcon size={Math.round(size * 0.55)} />
      ) : (
        <>
          <span className="transition-opacity group-hover:opacity-0">{initial(seed)}</span>
          <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <CheckIcon size={Math.round(size * 0.55)} />
          </span>
        </>
      )}
    </button>
  );
}

function CheckIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <polyline
        points="3,8 7,12 13,4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
