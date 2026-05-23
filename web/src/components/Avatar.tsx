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

export default function Avatar({
  seed,
  size = 36,
}: {
  seed: string;
  size?: number;
}) {
  const bg = PALETTE[hash(seed) % PALETTE.length];
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center justify-center font-bold"
      style={{
        width: size,
        height: size,
        background: bg,
        color: '#fff',
        fontSize: Math.round(size * 0.45),
        lineHeight: 1,
        border: '1px solid #000',
      }}
    >
      {initial(seed)}
    </div>
  );
}
