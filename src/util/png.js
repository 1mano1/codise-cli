// Decodificador PNG mínimo (8 bits, RGB/RGBA/gris/paleta, sin entrelazado) usando zlib nativo.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { L } from '../i18n.js';

export function decodePNG(file) {
  const buf = fs.readFileSync(file);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error(L('No es un archivo PNG válido', 'Not a valid PNG file'));
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(L(`Profundidad de ${bitDepth} bits no soportada (usa PNG de 8 bits)`, `${bitDepth}-bit depth not supported (use an 8-bit PNG)`));
  if (interlace) throw new Error(L('PNG entrelazado no soportado', 'Interlaced PNG not supported'));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(L(`Tipo de color PNG ${colorType} no soportado`, `PNG color type ${colorType} not supported`));
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      if (colorType === 6) { out[o] = line[i]; out[o + 1] = line[i + 1]; out[o + 2] = line[i + 2]; out[o + 3] = line[i + 3]; }
      else if (colorType === 2) { out[o] = line[i]; out[o + 1] = line[i + 1]; out[o + 2] = line[i + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = line[i]; out[o + 3] = 255; }
      else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = line[i]; out[o + 3] = line[i + 1]; }
      else if (colorType === 3) {
        const idx = line[i];
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

// Reduce la imagen a como máximo `max` píxeles de lado y la convierte en una mascota (paleta + filas).
export function pngToMascot(file, { max = 24, name = 'Mascota' } = {}) {
  const img = decodePNG(file);
  const scale = Math.max(img.width, img.height) / max;
  const w = Math.max(1, Math.round(img.width / Math.max(scale, 1)));
  const h = Math.max(1, Math.round(img.height / Math.max(scale, 1)));
  const symbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const palette = {};
  const colorToSym = new Map();
  const pixels = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * img.width / w));
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * img.height / h));
      const o = (sy * img.width + sx) * 4;
      if (img.data[o + 3] < 128) { row += '.'; continue; }
      // cuantizar a 4 bits por canal para limitar la paleta
      const q = (v) => Math.min(255, Math.round(v / 17) * 17);
      const hex = '#' + [q(img.data[o]), q(img.data[o + 1]), q(img.data[o + 2])].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      let sym = colorToSym.get(hex);
      if (!sym) {
        sym = symbols[colorToSym.size] || symbols.at(-1);
        colorToSym.set(hex, sym);
        palette[sym] = hex;
      }
      row += sym;
    }
    pixels.push(row);
  }
  return { name, palette, pixels, verbs: [], eyes: null, mouth: null };
}
