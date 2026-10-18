// Crops the generated storefront photos to the part between the empty sign band and the pavement (the
// game builds its own lit sign above and the real sidewalk is below) and writes them as WebP.
// Usage: node scripts/storefronts.mjs   (reads assets/generated/storefront/*.jpg)
import sharp from 'sharp';
import fs from 'node:fs';
const SRC = 'assets/generated/storefront', DST = 'public/assets/storefront';
// [top, bottom] as fractions of the image height
export const CROP = {
  arcade: [0.29, 0.8], clinic: [0.2, 0.8], courthouse: [0.17, 0.83], fish_market: [0.2, 0.82], hotel: [0.17, 0.85],
  laundromat: [0.2, 0.83], night_market: [0.3, 0.88], noodle_row: [0.21, 0.85], pier9: [0.21, 0.77], tattoo: [0.2, 0.85],
  tower: [0.16, 0.86], union_hall: [0.16, 0.84],
};
fs.mkdirSync(DST, { recursive: true });
const sizes = {};
for (const [k, [t, b]] of Object.entries(CROP)) {
  const img = sharp(`${SRC}/${k}.jpg`);
  const { width, height } = await img.metadata();
  const top = Math.round(t * height), h = Math.round((b - t) * height);
  await img.extract({ left: 0, top, width, height: h }).webp({ quality: 82 }).toFile(`${DST}/${k}.webp`);
  sizes[k] = +(width / h).toFixed(3);
}
console.log(JSON.stringify(sizes));
