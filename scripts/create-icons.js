#!/usr/bin/env node
// Generates assets/icon.png (512x512) and assets/tray-icon.png (22x22)
// using only Node.js built-ins — no extra dependencies.

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const r = Buffer.alloc(4); r.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, r]);
}

function makePNG(size, drawFn) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawFn(x, y, size);
      row[1 + x*4]     = r;
      row[1 + x*4 + 1] = g;
      row[1 + x*4 + 2] = b;
      row[1 + x*4 + 3] = a;
    }
    rows.push(row);
  }

  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── App icon: 512×512 rounded-square with "C" glyph ──────────────────────────

function drawAppIcon(x, y, s) {
  const cx = s / 2, cy = s / 2, r = s * 0.42;
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist > r) return [0,0,0,0];

  // Background gradient: deep blue-purple
  const t = dist / r;
  const bg = [
    Math.round(30 + t * 10),
    Math.round(40 + t * 10),
    Math.round(80 + t * 20),
    255,
  ];

  // Draw a bold "C" arc
  const angle = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180
  const cr = r * 0.52, cw = r * 0.14;
  const cd = Math.abs(dist - cr);
  const gapStart = -40, gapEnd = 40;
  const inArc = cd < cw && !(angle > gapStart && angle < gapEnd);
  if (inArc) return [180, 210, 255, 255];

  return bg;
}

// ── Tray icon: 22×22 simple dot ───────────────────────────────────────────────

function drawTrayIcon(x, y, s) {
  const cx = s/2, cy = s/2, r = s*0.38;
  const d = Math.sqrt((x-cx)**2 + (y-cy)**2);
  if (d > r) return [0,0,0,0];
  const edge = Math.max(0, Math.min(1, (r - d)));
  const a = Math.round(edge * 220);
  return [180, 210, 255, a];
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

fs.writeFileSync(path.join(assetsDir, 'icon.png'),       makePNG(512, drawAppIcon));
fs.writeFileSync(path.join(assetsDir, 'tray-icon.png'),  makePNG(22,  drawTrayIcon));

console.log('Icons generated in assets/');
