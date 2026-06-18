/**
 * Generates icon16.png, icon48.png, icon128.png using only Node.js built-ins.
 * Run once: node icons/generate-icons.js
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ─── CRC32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len  = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb   = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crcB]);
}

function makePng(pixels, size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = 1 + x * 4;
      row[d] = pixels[s]; row[d+1] = pixels[s+1]; row[d+2] = pixels[s+2]; row[d+3] = pixels[s+3];
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Pixel blending ───────────────────────────────────────────────────────────

function blend(pixels, size, px, py, r, g, b, alpha) {
  const x = Math.round(px), y = Math.round(py);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i    = (y * size + x) * 4;
  const srcA = alpha, dstA = pixels[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  pixels[i]     = Math.round((r * srcA + pixels[i]     * dstA * (1 - srcA)) / outA);
  pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
  pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
  pixels[i + 3] = Math.round(outA * 255);
}

// ─── Drawing primitives ───────────────────────────────────────────────────────

// Anti-aliased ring using SDF — avoids fill+punch artifacts
function drawRing(pixels, size, cx, cy, outerR, innerR, R, G, B) {
  const m = Math.ceil(outerR) + 2;
  for (let y = Math.max(0, Math.floor(cy - m)); y <= Math.min(size - 1, Math.ceil(cy + m)); y++) {
    for (let x = Math.max(0, Math.floor(cx - m)); x <= Math.min(size - 1, Math.ceil(cx + m)); x++) {
      const dist = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      // Coverage is high only in the band between innerR and outerR
      const outer = Math.max(0, Math.min(1, outerR - dist + 0.5));
      const inner = Math.max(0, Math.min(1, dist - innerR + 0.5));
      const a = outer * inner;
      if (a > 0) blend(pixels, size, x, y, R, G, B, a);
    }
  }
}

// Anti-aliased thick line (as swept circles along the path)
function drawLine(pixels, size, x1, y1, x2, y2, w, R, G, B) {
  const len   = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const steps = Math.max(1, Math.ceil(len * 3));
  const r     = w / 2;
  for (let s = 0; s <= steps; s++) {
    const t  = s / steps;
    const cx = x1 + (x2 - x1) * t;
    const cy = y1 + (y2 - y1) * t;
    const m  = Math.ceil(r) + 2;
    for (let y = Math.max(0, Math.floor(cy - m)); y <= Math.min(size - 1, Math.ceil(cy + m)); y++) {
      for (let x = Math.max(0, Math.floor(cx - m)); x <= Math.min(size - 1, Math.ceil(cx + m)); x++) {
        const dist = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
        const a = Math.max(0, Math.min(1, r - dist + 0.5));
        if (a > 0) blend(pixels, size, x, y, R, G, B, a);
      }
    }
  }
}

// SDF coverage for rounded rect
function rrCoverage(px, py, x1, y1, x2, y2, r) {
  const qx = Math.max(x1 + r - px, 0, px - (x2 - r));
  const qy = Math.max(y1 + r - py, 0, py - (y2 - r));
  return Math.max(0, Math.min(1, 0.5 - (Math.sqrt(qx * qx + qy * qy) - r)));
}

// ─── Icon builder ─────────────────────────────────────────────────────────────

function buildIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const [PR, PG, PB] = [97, 124, 156]; // #617C9C — steel blue

  // Rounded-square background (slightly inset for clean AA edges)
  const pad    = size * 0.07;
  const corner = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = rrCoverage(x + 0.5, y + 0.5, pad, pad, size - pad, size - pad, corner);
      if (a > 0) blend(pixels, size, x, y, PR, PG, PB, a);
    }
  }

  // Magnifying glass — scaled proportions so it reads at every size
  const cx = size * 0.40;
  const cy = size * 0.38;

  // Thicker ring at small sizes so it stays visible at 16 px
  const outerR  = size * 0.26;
  const ringW   = Math.max(1.8, size * 0.10); // min 1.8 px ring thickness
  const innerR  = outerR - ringW;
  const handleW = Math.max(1.8, size * 0.105);

  // Handle endpoint going to bottom-right at 45°
  const hx1 = cx + outerR * Math.cos(Math.PI / 4) * 0.80;
  const hy1 = cy + outerR * Math.sin(Math.PI / 4) * 0.80;
  const hx2 = size * 0.80;
  const hy2 = size * 0.80;

  // Draw handle first, ring on top for clean overlap
  drawLine(pixels, size, hx1, hy1, hx2, hy2, handleW, 255, 255, 255);
  drawRing(pixels, size, cx, cy, outerR, innerR, 255, 255, 255);

  return pixels;
}

// ─── Generate ─────────────────────────────────────────────────────────────────

for (const size of [16, 48, 128]) {
  const png  = makePng(buildIcon(size), size);
  const file = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓  icon${size}.png  (${png.length} bytes)`);
}
