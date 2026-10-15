#!/usr/bin/env node
// Touch-device check of HUD + controls on phone and tablet sizes (driving and on foot).
// Usage: node scripts/shots_mobile.mjs [url] [outDir] [device,...]
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'http://localhost:4173/?q=low&fixed';
const out = process.argv[3] || 'screenshots';
const want = (process.argv[4] || 'phone,phone-portrait,tablet,tablet-portrait').split(',');
fs.mkdirSync(out, { recursive: true });
const DEVICES = {
  phone: devices['iPhone 13 landscape'],
  'phone-portrait': devices['iPhone 13'],
  tablet: devices['iPad (gen 7) landscape'],
  'tablet-portrait': devices['iPad (gen 7)'],
};
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const name of want) {
  const ctx = await browser.newContext({ ...DEVICES[name] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__neon && window.__neon.state() === 'title', null, { timeout: 600000 });
  await page.screenshot({ path: path.join(out, `${name}_0_title.png`) });
  if (name.endsWith('portrait') && name.startsWith('phone')) { console.log(name, 'errors', errors.length); await ctx.close(); continue; }
  await page.tap('button[data-act="story"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, `${name}_1_story.png`) });
  await page.tap('#story button[data-act="back"]');
  await page.tap('button[data-act="play"]');
  const N = (fn, ...a) => page.evaluate(([f, args]) => window.__neon[f](...args), [fn, a]);
  await page.waitForFunction(() => window.__neon.simTime() > 2, null, { timeout: 600000 });
  await page.screenshot({ path: path.join(out, `${name}_2_drive.png`) });
  await N('exitCar');
  const t0 = await N('simTime');
  await page.waitForFunction((t) => window.__neon.simTime() > t + 2.5, t0, { timeout: 600000 });
  await page.screenshot({ path: path.join(out, `${name}_3_foot.png`) });
  const boxes = await page.evaluate(() => [...document.querySelectorAll('#touch button, #t-base, #minimap, .hud-tc, .hud-tl, .hud-br')]
    .filter((e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none')
    .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }));
  // overlap report between visible controls / HUD blocks
  const ov = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) ov.push(`${a.id}×${b.id}`);
  }
  const vw = page.viewportSize();
  const off = boxes.filter((b) => b.x < 0 || b.y < 0 || b.x + b.w > vw.width || b.y + b.h > vw.height).map((b) => b.id);
  console.log(name, JSON.stringify(vw), 'overlaps:', ov.join(', ') || 'none', '| offscreen:', off.join(', ') || 'none', '| errors', errors.length, errors.slice(0, 3));
  await ctx.close();
}
await browser.close();
