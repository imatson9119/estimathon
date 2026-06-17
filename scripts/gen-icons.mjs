// Generates the app icons (no external deps) so the PWA manifest and Apple
// touch icon are real PNGs. Re-run with `node scripts/gen-icons.mjs` after
// tweaking the look. Output lands in ./public.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [14, 19, 48];      // #0e1330 deep navy
const GOLD = [255, 206, 107]; // #ffce6b
const GOLD2 = [244, 169, 58]; // #f4a93a

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const px = (x, y, rgb) => {
    const o = y * (size * 3 + 1) + 1 + x * 3;
    raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
  };
  const raw = Buffer.alloc(size * (size * 3 + 1)); // +1 filter byte per row
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.30;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // background with a soft radial glow toward gold near the disc
      const glow = Math.max(0, 1 - dist / (r * 2.4));
      let col = [
        Math.round(BG[0] + (GOLD[0] - BG[0]) * 0.10 * glow),
        Math.round(BG[1] + (GOLD[1] - BG[1]) * 0.10 * glow),
        Math.round(BG[2] + (GOLD[2] - BG[2]) * 0.10 * glow),
      ];
      if (dist <= r) {
        const t = dist / r; // gradient across the disc
        col = [
          Math.round(GOLD[0] + (GOLD2[0] - GOLD[0]) * t),
          Math.round(GOLD[1] + (GOLD2[1] - GOLD[1]) * t),
          Math.round(GOLD[2] + (GOLD2[2] - GOLD[2]) * t),
        ];
      }
      px(x, y, col);
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL("../public", import.meta.url), { recursive: true });
for (const size of [180, 192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(size));
  console.log("wrote", out.pathname);
}
