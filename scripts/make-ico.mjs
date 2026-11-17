// Builds src-tauri/icons/icon.ico from app-icon.png.
//
// `tauri icon` stores every size as PNG, which Windows Explorer can render
// blank for small sizes. This writes classic 32-bit bitmap entries for every
// size below 256 px (the format Explorer always understands) and keeps PNG
// only for the 256 px entry, as Windows itself does.
//
//   node scripts/make-ico.mjs [source.png] [out.ico]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync, crc32 } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = process.argv[2] ?? `${root}app-icon.png`;
const out = process.argv[3] ?? `${root}src-tauri/icons/icon.ico`;
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** RGBA pixels of an 8-bit, non-interlaced RGB or RGBA PNG. */
export function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) {
        throw new Error("only 8-bit, non-interlaced RGB or RGBA PNGs are supported");
      }
    } else if (kind === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[y * stride + x - bpp] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rows[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][filter];
      rows[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rows.copy(rgba, i * 4, i * bpp, i * bpp + 3);
    rgba[i * 4 + 3] = bpp === 4 ? rows[i * 4 + 3] : 255;
  }
  return { width, height, rgba };
}

/** Scales a square image down to `size`, averaging each covered area (alpha-weighted). */
export function resize(img, size) {
  const out = Buffer.alloc(size * size * 4);
  const f = img.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      let area = 0;
      for (let sy = Math.floor(y * f); sy < Math.ceil((y + 1) * f); sy++) {
        const wy = Math.min(sy + 1, (y + 1) * f) - Math.max(sy, y * f);
        for (let sx = Math.floor(x * f); sx < Math.ceil((x + 1) * f); sx++) {
          const w = wy * (Math.min(sx + 1, (x + 1) * f) - Math.max(sx, x * f));
          const i = (sy * img.width + sx) * 4;
          const alpha = img.rgba[i + 3] * w;
          for (let c = 0; c < 3; c++) acc[c] += img.rgba[i + c] * alpha;
          acc[3] += alpha;
          area += w;
        }
      }
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = acc[3] ? Math.round(acc[c] / acc[3]) : 0;
      out[o + 3] = Math.round(acc[3] / area);
    }
  }
  return { width: size, height: size, rgba: out };
}

export function encodePng(img) {
  const chunk = (kind, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(kind, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    img.rgba.copy(raw, y * (img.width * 4 + 1) + 1, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 32-bit bitmap entry: header, BGRA rows bottom first, then an empty AND mask. */
function dib(img) {
  const size = img.width;
  const header = Buffer.alloc(40);
  // The height counts the color rows plus the AND mask.
  header.writeInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeInt16LE(1, 12);
  header.writeInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const o = ((size - 1 - y) * size + x) * 4;
      pixels.set([img.rgba[i + 2], img.rgba[i + 1], img.rgba[i], img.rgba[i + 3]], o);
    }
  }
  // AND mask: all zero (alpha does the work), rows padded to 32 bits.
  return Buffer.concat([header, pixels, Buffer.alloc(Math.ceil(size / 32) * 4 * size)]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = decodePng(readFileSync(source));
  const images = sizes.map((s) => {
    const img = resize(src, s);
    return s === 256 ? encodePng(img) : dib(img);
  });
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    // 0 means 256.
    dir[e] = s % 256;
    dir[e + 1] = s % 256;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  writeFileSync(out, Buffer.concat([dir, ...images]));
  console.log(`wrote ${out}`);
}
