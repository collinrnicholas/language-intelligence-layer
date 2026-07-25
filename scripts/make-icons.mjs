// ─── Persado mark — icon generator ───────────────────────────────
//
//   node scripts/make-icons.mjs
//
// Writes extension/public/icon.svg (the source of truth) and the PNG set
// (16/32/48/128/512 + dimmed variants for the Disabled action state) from the
// single GEOMETRY definition below, so the SVG and the PNGs can never drift.
//
// Why hand-rasterize instead of scaling a 512 down: the mark has to survive at
// real 16px toolbar size (claude-design.md §4). The geometry is laid out on a
// 16-unit grid of axis-aligned rectangles, so at every export size (all
// multiples of 16) each edge lands exactly on a pixel boundary — no blurring,
// no antialiasing of the strokes, and the 2px minimum stroke weight is exact.

import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'public');

const INK = '#1A1128'; // wordmark / P
const RED = '#DC2828'; // brackets
const SURFACE = '#FFFFFF'; // tile — ink is near-black, so the mark needs a light
                           // tile to stay legible on dark Chrome themes.

// ─── Geometry (16-unit grid) ─────────────────────────────────────
//
// Budget across the 16 units: 1 padding | bracket | 1 clear | P | 1 clear |
// bracket | 1 padding. Every stroke is >= 2 units (= 2px at 16px).
//
//   x: 0 1    4 5      11 12   15 16
//      ┌─────────────────────────────┐
//      │  ┌──┐    ▄▄▄▄▄▄    ┌──┐     │  y=1   bracket returns, 2 tall
//      │  │       █  ▄▄█       │     │
//      │  │       █▄▄▄▄▄       │     │        P bowl, counter 2x2
//      │  │       █            │     │
//      │  └──┘    █         └──┘     │  y=15
//      └─────────────────────────────┘
//
// Brackets are true bracket forms: a 2-wide vertical stem with 3-long
// horizontal returns at top and bottom (not the bare vertical bars we shipped
// before). The P is uppercase, 2-wide stems throughout.
const GEOMETRY = {
  brackets: [
    // left: return, stem, return
    [1, 1, 3, 2], [1, 3, 2, 10], [1, 13, 3, 2],
    // right: mirrored
    [12, 1, 3, 2], [13, 3, 2, 10], [12, 13, 3, 2],
  ],
  // Uppercase P spanning x 5–11, y 3–13. The counter (hole) is the gap left at
  // x 7–9, y 5–8 — enclosed by the stem, top bar, right wall and middle bar.
  // 2x3 rather than a square: at 16px a 2x2 counter closes up visually and the
  // glyph stops reading as a P, so the bowl is deepened to keep the hole open.
  p: [
    [5, 3, 2, 10],  // stem
    [5, 3, 6, 2],   // top bar
    [9, 3, 2, 7],   // right wall of the bowl
    [5, 8, 6, 2],   // middle bar (closes the counter)
  ],
};
const GRID = 16;
const TILE_RADIUS = 1; // = 8px at 128px, matching the 8px icon-tile radius

// ─── Rasterizer ──────────────────────────────────────────────────

const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

/** Coverage of a rounded rect at a sample point, 0 or 1 (corners supersampled). */
function inRoundedRect(x, y, size, r) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = x < r ? r : x > size - r ? size - r : x;
  const cy = y < r ? r : y > size - r ? size - r : y;
  if (cx === x || cy === y) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * Render the mark at `size` px. `dim` blends the mark toward the tile to make
 * the ~40%-opacity Disabled variant (§4) without an alpha-composited PNG.
 */
function render(size, { dim = false } = {}) {
  const s = size / GRID;                 // units → px (always an integer here)
  const px = new Uint8Array(size * size * 4);
  const [tr, tg, tb] = hex(SURFACE);
  const radius = TILE_RADIUS * s;
  const markAlpha = dim ? 0.4 : 1;
  const SS = 4;                          // supersampling, only the tile corners need it

  const rects = [
    ...GEOMETRY.brackets.map(r => [r, hex(RED)]),
    ...GEOMETRY.p.map(r => [r, hex(INK)]),
  ].map(([[x, y, w, h], c]) => [x * s, y * s, w * s, h * s, c]);

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      // Tile coverage (antialiased corners).
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inRoundedRect(pxi + (sx + 0.5) / SS, py + (sy + 0.5) / SS, size, radius)) cov++;
        }
      }
      cov /= SS * SS;

      let [r, g, b] = [tr, tg, tb];
      // The mark: pixel centres against integer-aligned rects → exact hits.
      const cxp = pxi + 0.5, cyp = py + 0.5;
      for (const [rx, ry, rw, rh, c] of rects) {
        if (cxp >= rx && cxp < rx + rw && cyp >= ry && cyp < ry + rh) {
          r = Math.round(c[0] * markAlpha + tr * (1 - markAlpha));
          g = Math.round(c[1] * markAlpha + tg * (1 - markAlpha));
          b = Math.round(c[2] * markAlpha + tb * (1 - markAlpha));
          break;
        }
      }

      const o = (py * size + pxi) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(cov * 255);
    }
  }
  return encodePng(size, size, px);
}

// ─── Minimal PNG encoder (RGBA8, filter 0) ───────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── SVG source ──────────────────────────────────────────────────

function svg() {
  const rect = ([x, y, w, h], fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="512" height="512" shape-rendering="crispEdges">`,
    '  <title>Persado — bracketed P</title>',
    `  <rect width="${GRID}" height="${GRID}" rx="${TILE_RADIUS}" fill="${SURFACE}"/>`,
    '  <!-- brackets: 2-wide stem with 3-long returns, Persado red -->',
    ...GEOMETRY.brackets.map(r => '  ' + rect(r, RED)),
    '  <!-- uppercase P in ink; the counter is the gap at x7-9 y5-7 -->',
    ...GEOMETRY.p.map(r => '  ' + rect(r, INK)),
    '</svg>',
    '',
  ].join('\n');
}

// ─── Write ───────────────────────────────────────────────────────

const SIZES = { 'icon16.png': 16, 'icon32.png': 32, 'icon48.png': 48, 'icon.png': 128, 'icon512.png': 512 };
const DIM = { 'icon16-disabled.png': 16, 'icon32-disabled.png': 32, 'icon48-disabled.png': 48, 'icon-disabled.png': 128 };

writeFileSync(join(OUT, 'icon.svg'), svg());
console.log('icon.svg');
for (const [name, size] of Object.entries(SIZES)) {
  writeFileSync(join(OUT, name), render(size));
  console.log(`${name} (${size}px)`);
}
for (const [name, size] of Object.entries(DIM)) {
  writeFileSync(join(OUT, name), render(size, { dim: true }));
  console.log(`${name} (${size}px, dimmed)`);
}
