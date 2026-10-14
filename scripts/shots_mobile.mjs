#!/usr/bin/env node
// Phone-sized check of HUD + touch controls (landscape). Usage: node scripts/shots_mobile.mjs [url] [outDir]
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'http://localhost:4173/?q=low&fixed';
const out = process.argv[3] || 'screenshots';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ ...devices['iPhone 13 landscape'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => window.__neon && window.__neon.state() === 'title', null, { timeout: 600000 });
await page.screenshot({ path: path.join(out, 'm0_title.png') });
await page.tap('button[data-act="play"]');
await page.waitForFunction(() => window.__neon.simTime() > 3, null, { timeout: 600000 });
await page.screenshot({ path: path.join(out, 'm1_hud.png') });
console.log('mobile errors', errors.length, errors.slice(0, 5));
await browser.close();
