/**
 * Generates the PWA / iOS home-screen icons in ./public.
 *
 * Brutalist mark: solid black square with a square white frame inset and a
 * smaller solid white block in the middle, evoking the hairline frames used
 * throughout the UI. No text, no antialiasing, no fonts — every pixel is
 * either black (0x00) or white (0xff), authored by hand.
 *
 * Run with: node scripts/gen-icons.mjs
 * Re-run only if you want to change the visual or sizes; the output PNGs
 * are committed to the repo.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BLACK = 0x00;
const WHITE = 0xff;

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size, fill) {
  // 8-bit grayscale (color type 0). One filter byte (0 = None) per scanline,
  // then `size` pixel bytes.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      raw[rowStart + 1 + x] = fill(x, y);
    }
  }

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Pixel rule: pure black square, white inset frame (~6% of side), with a
// solid white square nested inside the frame at the midpoint, sized at
// ~24% of the side. Reads as a brutalist black-on-black stamp.
function mark(size) {
  const frame = Math.max(2, Math.round(size * 0.06));
  const frameInset = Math.max(1, Math.round(size * 0.12));
  const frameThick = Math.max(1, Math.round(size * 0.012));
  const innerHalf = Math.round(size * 0.12);
  const cx = Math.floor(size / 2);
  const cy = Math.floor(size / 2);

  return (x, y) => {
    // Outer frame border: a thin white square at `frameInset` from the edge.
    const minD = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (minD >= frameInset && minD < frameInset + frameThick) return WHITE;
    // Inner solid white square at center.
    if (Math.abs(x - cx) < innerHalf && Math.abs(y - cy) < innerHalf) return WHITE;
    // Maskable safe area note: the central element sits well inside the
    // 80% safe zone, so the icon is also fine when used as `maskable`.
    void frame; // kept for readability; not used directly
    return BLACK;
  };
}

for (const size of [180, 192, 512]) {
  const png = makePng(size, mark(size));
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  writeFileSync(join(PUBLIC, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}
