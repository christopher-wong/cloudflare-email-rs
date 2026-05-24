/**
 * Initials-on-a-disc avatar. Deterministic palette: same input → same color
 * across reloads and tabs. The palette is the desaturated jewel-tone set
 * specified by the design system — never the accent (would steal the
 * encryption signal). For interactive variants (`onToggle`), the avatar
 * doubles as the row's checkbox: hovered shows an ink check overlay; when
 * selected, an accent-colored check replaces the avatar entirely.
 */

const PALETTE = [
  '#5C7A6B', // sage
  '#7E6B5A', // walnut
  '#6B6A8C', // muted indigo
  '#8A6B7A', // dusty plum
  '#555558', // graphite
  '#6B7E8C', // slate blue
  '#8C7E5A', // ochre
] as const;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '·';
  // Strip the domain so the disc shows the local-part initial. For multi-word
  // human names (no @), take the first letter of the first two words.
  const local = trimmed.split('@')[0];
  const words = local.replace(/[._\-+]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0][0]!.toUpperCase();
  return (words[0][0]! + words[1][0]!).toUpperCase();
}

export default function Avatar({
  seed,
  size = 32,
  selected = false,
  onToggle,
}: {
  seed: string;
  size?: number;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const bg = PALETTE[hash(seed) % PALETTE.length];
  const fontSize = Math.max(10, Math.round(size * 0.36));

  const discStyle: React.CSSProperties = {
    width: size,
    height: size,
    background: bg,
    fontSize,
  };

  if (!onToggle) {
    return (
      <span
        aria-hidden
        className="avatar"
        style={discStyle}
      >
        {initials(seed)}
      </span>
    );
  }

  // Interactive: avatar doubles as the row's checkbox. Stop propagation so
  // the surrounding row's onClick (navigate to thread) doesn't fire.
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={selected}
      aria-label={selected ? 'deselect thread' : 'select thread'}
      className="group relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        className={
          'absolute inset-0 grid place-items-center rounded-full text-white font-semibold transition-opacity ' +
          (selected ? 'opacity-0' : 'group-hover:opacity-30')
        }
        style={discStyle}
      >
        {initials(seed)}
      </span>
      <span
        className={
          'absolute inset-0 grid place-items-center rounded-full text-white transition-[opacity,transform,background] duration-150 ' +
          (selected
            ? 'opacity-100 scale-100 bg-accent'
            : 'opacity-0 scale-90 bg-ink group-hover:opacity-100 group-hover:scale-100')
        }
        style={{ width: size, height: size }}
      >
        <CheckIcon size={Math.round(size * 0.5)} />
      </span>
    </button>
  );
}

function CheckIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <polyline points="5 13 9 17 19 7" />
    </svg>
  );
}
