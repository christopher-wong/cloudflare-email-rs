/**
 * Generates the PWA / iOS home-screen icons and apple-touch-startup-image
 * splash screens into ./public.
 *
 * Brutalist mark: solid black square with a square white frame inset and a
 * smaller solid white block in the middle, evoking the hairline frames used
 * throughout the UI. No text, no antialiasing, no fonts — every pixel is
 * either black (0x00) or white (0xff), authored by hand.
 *
 * Splash screens place the same mark, centered at ~30% of the shorter
 * dimension, on a white field that matches the app's background_color so
 * the launch-to-app transition is seamless on iOS.
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

function makePng(w, h, fill) {
  // 8-bit grayscale (color type 0). One filter byte (0 = None) per scanline,
  // then `w` pixel bytes.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < w; x++) {
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

// Pixel rule for an icon: pure black square, white inset frame (~1px hairline
// at ~12% from the edge), with a solid white square nested inside the frame
// at the midpoint, sized at ~24% of the side. Reads as a brutalist
// black-on-black stamp. The central element sits well inside the 80% safe
// zone, so the icon is also fine when used as `maskable`.
function mark(size) {
  const frameInset = Math.max(1, Math.round(size * 0.12));
  const frameThick = Math.max(1, Math.round(size * 0.012));
  const innerHalf = Math.round(size * 0.12);
  const cx = Math.floor(size / 2);
  const cy = Math.floor(size / 2);

  return (x, y) => {
    const minD = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (minD >= frameInset && minD < frameInset + frameThick) return WHITE;
    if (Math.abs(x - cx) < innerHalf && Math.abs(y - cy) < innerHalf) return WHITE;
    return BLACK;
  };
}

// Compose: place a smaller `mark` of size `markSize` centered on a white
// canvas of size w × h.
function splashFill(w, h) {
  const markSize = Math.round(Math.min(w, h) * 0.3);
  const x0 = Math.floor((w - markSize) / 2);
  const y0 = Math.floor((h - markSize) / 2);
  const inner = mark(markSize);
  return (x, y) => {
    const lx = x - x0;
    const ly = y - y0;
    if (lx < 0 || lx >= markSize || ly < 0 || ly >= markSize) return WHITE;
    return inner(lx, ly);
  };
}

// Icons (square).
for (const size of [180, 192, 512]) {
  const png = makePng(size, size, mark(size));
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  writeFileSync(join(PUBLIC, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}

// Splash screens (portrait). Sized for current iPhones; the matching
// `apple-touch-startup-image` media queries live in index.html. iOS will
// gracefully fall back if a target device's exact size isn't listed.
const SPLASHES = [
  { w: 1290, h: 2796, note: 'iPhone 14/15/16 Pro Max' },
  { w: 1284, h: 2778, note: 'iPhone 12/13/14 Plus' },
  { w: 1179, h: 2556, note: 'iPhone 14/15/16 Pro' },
  { w: 1170, h: 2532, note: 'iPhone 12/13/14/15/16' },
  { w: 1125, h: 2436, note: 'iPhone X/XS/11 Pro' },
  { w: 828,  h: 1792, note: 'iPhone XR/11' },
  { w: 750,  h: 1334, note: 'iPhone 6/7/8' },
];

for (const { w, h, note } of SPLASHES) {
  const png = makePng(w, h, splashFill(w, h));
  const name = `splash-${w}x${h}.png`;
  writeFileSync(join(PUBLIC, name), png);
  console.log(`wrote ${name} (${png.length} bytes) — ${note}`);
}

