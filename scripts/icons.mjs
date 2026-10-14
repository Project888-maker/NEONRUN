// Rasterize recraft SVG icons -> 128px white-on-transparent PNGs (alpha from luminance).
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
const SRC = 'assets/generated/icon', DST = 'public/assets/icon';
fs.mkdirSync(DST, { recursive: true });
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith('.svg'))) {
  const { data, info } = await sharp(path.join(SRC, f), { density: 300 }).resize(128, 128, { fit: 'contain', background: '#000' }).flatten({ background: '#000' }).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * info.channels], g = data[i * info.channels + 1], b = data[i * info.channels + 2];
    const l = Math.max(r, g, b);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
    out[i * 4 + 3] = Math.max(0, Math.min(255, (l - 30) * 1.25));
  }
  const name = f.replace(/^i\d+_/, '').replace('.svg', '.png');
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(path.join(DST, name));
}
console.log('icons', fs.readdirSync(DST).join(' '));
