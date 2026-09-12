'use strict';
/**
 * Generates build/icon.ico for the electron-builder NSIS installer (T-021).
 *
 * Dependency-free on purpose: the repo ships no image tooling and no binary assets, so the icon is
 * drawn here with signed-distance fields, encoded as a 256x256 RGBA PNG with zlib, and wrapped in a
 * single-image ICO (PNG payload, the Vista+ form Windows and electron-builder both accept).
 *
 *   node build/make-icon.js            # writes build/icon.ico
 *
 * Re-run after editing the palette or the mark; commit the .ico alongside this script.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// --- palette -------------------------------------------------------------------------------------
const BG_TOP = [0x16, 0x1d, 0x2b];   // dark slate, top of the tile
const BG_BOTTOM = [0x0d, 0x11, 0x1a];// near-black, bottom of the tile
const RING = [0x58, 0xa6, 0xff];     // the orbit: Mission Control blue
const CORE = [0xe6, 0xed, 0xf5];     // the station at the centre
const BLIP = [0xff, 0xb4, 0x54];     // the worker on the orbit

// --- signed distance helpers --------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** 0 outside, 1 inside, soft over one pixel: the only anti-aliasing this icon needs. */
const cover = (d) => clamp(0.5 - d, 0, 1);
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
/** ring of radius r and stroke width w */
const sdRing = (x, y, cx, cy, r, w) => Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;

/** src over dst, both straight (non-premultiplied) RGBA in 0..255, alpha 0..1 for src. */
function over(dst, i, rgb, a) {
  if (a <= 0) return;
  const da = dst[i + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) { dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0; return; }
  for (let c = 0; c < 3; c++) dst[i + c] = Math.round((rgb[c] * a + dst[i + c] * da * (1 - a)) / outA);
  dst[i + 3] = Math.round(outA * 255);
}

function draw() {
  const px = Buffer.alloc(SIZE * SIZE * 4, 0);
  const c = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const sx = x + 0.5, sy = y + 0.5;
      // tile
      const t = y / (SIZE - 1);
      const bg = [0, 1, 2].map((k) => Math.round(BG_TOP[k] + (BG_BOTTOM[k] - BG_TOP[k]) * t));
      over(px, i, bg, cover(sdRoundRect(sx, sy, c, c, 120, 120, 54)));
      // orbit
      over(px, i, RING, cover(sdRing(sx, sy, c, c, 74, 11)) * 0.95);
      // inner orbit, dimmer
      over(px, i, RING, cover(sdRing(sx, sy, c, c, 44, 5)) * 0.45);
      // station
      over(px, i, CORE, cover(sdCircle(sx, sy, c, c, 17)));
      // worker blip on the outer orbit, upper right
      const bx = c + 74 * Math.cos(-Math.PI / 4), by = c + 74 * Math.sin(-Math.PI / 4);
      over(px, i, BLIP, cover(sdCircle(sx, sy, bx, by, 16)));
    }
  }
  return px;
}

// --- PNG ------------------------------------------------------------------------------------------
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // deflate, adaptive filtering, no interlace
  // one filter byte (0 = None) in front of every scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO ------------------------------------------------------------------------------------------
function ico(images) { // [{ size, data }]
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((img) => {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;  // 0 means 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; e[3] = 0;                     // palette colours, reserved
    e.writeUInt16LE(1, 4);                  // colour planes
    e.writeUInt16LE(32, 6);                 // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    return e;
  });
  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

const out = path.join(__dirname, 'icon.ico');
const buf = ico([{ size: SIZE, data: png(draw(), SIZE) }]);
fs.writeFileSync(out, buf);
console.log(`${path.relative(process.cwd(), out)}  ${SIZE}x${SIZE}  ${buf.length} bytes`);
