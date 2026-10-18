#!/usr/bin/env node
// Automated visual + telemetry check with headless Chromium.
// Usage: node scripts/shots.mjs [url] [outDir] [scenario,...]
// Starts nothing itself: run `npx vite preview --port 4173` (or dev) first.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'http://localhost:4173/?debug&q=high';
const out = process.argv[3] || 'screenshots';
const only = (process.argv[4] || '').split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const W = +(process.env.SHOT_W || 960), H = Math.round((W * 9) / 16);
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__neon && window.__neon.state() === 'title', null, { timeout: 600000 });
const loadSec = (Date.now() - t0) / 1000;
console.log(new Date().toISOString().slice(11, 19), `loaded in ${loadSec.toFixed(1)}s`);
const want = (n) => !only.length || only.includes(n);
if (want('title')) await page.screenshot({ path: path.join(out, '00_title.png') });

const N = (fn, ...a) => page.evaluate(([f, args]) => window.__neon[f](...args), [fn, a]);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// with ?fixed the game advances 1/30 s per rendered frame, so wait on simulated time instead of wall time
const sleep = async (ms) => {
  if (!url.includes('fixed')) return realSleep(ms);
  const t0 = await N('simTime');
  await page.waitForFunction((t) => window.__neon.simTime() >= t, t0 + ms / 1000, { timeout: 600000, polling: 200 });
};
const shot = async (name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); const t = await N('telemetry'); console.log(new Date().toISOString().slice(11, 19), name, JSON.stringify({ kmh: t.kmh.toFixed(0), fps: t.fps?.toFixed(1), calls: t.calls, tris: t.tris, drift: t.drifting, pos: t.pos.map((v) => v.toFixed(0)).join(',') })); return t; };

if (want('ui')) {
  await page.click('button[data-act="garage"]');
  await realSleep(800);
  await page.screenshot({ path: path.join(out, '00_garage.png') });
  await page.click('#garage button[data-act="back"]');
  await page.click('button[data-act="settings"]');
  await realSleep(500);
  await page.screenshot({ path: path.join(out, '00_settings.png') });
  await page.click('#settings button[data-act="back"]');
}
await N('start');
await N('unlockAll');
await sleep(2500);
if (want('start')) await shot('01_start');

if (want('drive')) {
  await N('setInput', { throttle: 1 });
  await sleep(6000);
  await shot('02_driving');
  await N('setInput', { throttle: 1, boost: true });
  await sleep(3000);
  await shot('03_boost');
}
if (want('drift')) {
  // open stretch of road: outer ring road on the west side, heading +Z
  await N('setInput', {});
  await N('teleport', -768 - 1.75, -600, 0);
  await sleep(500);
  await N('setInput', { throttle: 1 });
  await sleep(3500);
  await N('setInput', { throttle: 1, steer: -0.8, handbrake: true });
  await sleep(1200);
  await N('setInput', { throttle: 1, steer: -0.6 });
  await sleep(1200);
  await shot('04_drift');
  await N('setInput', { brake: 1 });
  await sleep(3000);
  await shot('05_brake');
}
if (want('mission')) {
  await N('setInput', {});
  let m = await N('mission');
  const [tx, , tz] = m.target;
  await N('teleport', tx + 3, tz + 3, 0);
  await sleep(2000);
  m = await N('mission');
  console.log('mission after pickup', JSON.stringify(m));
  await shot('20_delivery');
  const [dx, , dz] = m.target;
  await N('teleport', dx + 3, dz + 3, 0);
  await sleep(1500);
  await shot('21_results');
  await sleep(6000);
  console.log('mission after results', JSON.stringify(await N('mission')));
}
const places = [
  ['06_neon', -384 + 1.75, -420, Math.PI],
  ['07_downtown', 192 + 1.75, -330, Math.PI],
  ['08_backstreets', -480 + 1.75, 300, 0],
  ['09_docks', 480 + 1.75, 320, 0],
];
for (const [name, x, z, yaw] of places) {
  if (!want(name) && !want('places')) continue;
  await N('setInput', {});
  await N('teleport', x, z, yaw);
  await sleep(1500);
  await N('setInput', { throttle: 0.6 });
  await sleep(2500);
  await shot(name);
}
if (want('cars')) {
  // drive each generated car for a moment on the start avenue
  for (const id of ['car_taxi', 'car_police', 'car_super', 'car_pickup']) {
    await N('setInput', {});
    await N('teleport', -382.25, -150, Math.PI);
    await N('setCar', id);
    await sleep(800);
    await N('setInput', { throttle: 0.7 });
    await sleep(1800);
    await shot(`30_${id}`);
  }
  await N('setInput', {});
  await N('setCar', 'hero');
  for (let k = 0; k < 3; k++) {
    console.log('behind', JSON.stringify(await N('behindTraffic', k * 2)));
    await sleep(300);
    await N('setInput', { throttle: 0.35 });
    await sleep(1200);
    await shot(`31_traffic_${k}`);
    await N('setInput', {});
  }
}
if (want('foot')) {
  await N('setInput', {});
  await sleep(500);
  await N('exitCar');
  await sleep(1600);
  console.log('mode', await N('mode'));
  await shot('40_exit');
  await N('setInput', { footZ: 1 });
  await sleep(1500);
  await shot('41_walk');
  await N('setInput', { footZ: 1, run: true });
  await sleep(1500);
  await shot('42_run');
  await N('setInput', {});
  // walk up to the nearest pedestrian and talk
  const pp = await N('nearestPed');
  console.log('peds', JSON.stringify(await N('peds')));
  if (pp) { await N('heroTo', pp[0] + 1.4, pp[2] + 0.6); await sleep(400); await N('talk'); await sleep(2500); await shot('43_talk'); await N('convLeave'); }
  // steal a traffic car
  console.log('door', JSON.stringify(await N('toTrafficDoor')));
  await sleep(600);
  await shot('44_at_door');
  await N('enterCar');
  await sleep(1200);
  await shot('45_carjack');
  await sleep(3000);
  console.log('mode after steal', await N('mode'));
  await shot('46_stolen');
  await N('setInput', { throttle: 1 });
  await sleep(4000);
  await shot('47_police');
  await N('setInput', {});
}
if (want('rain')) {
  // rain only: standing still, then driving (streaks lengthen and slant with speed)
  console.log('rain', JSON.stringify(await N('rainInfo')));
  await shot('93_rain_still');
  await N('setInput', { throttle: 1 }); await sleep(3500);
  await shot('94_rain_speed');
  await N('setInput', {});
}
if (want('look')) {
  // hero standing under the neon (front and back) and the rain, on foot and driving
  await N('setInput', { throttle: 0.6 }); await sleep(2500); await N('setInput', { brake: 1 }); await sleep(1500); await N('setInput', {});
  await shot('90_rain_drive');
  await N('exitCar'); await sleep(3000);
  await shot('91_foot_back');
  await N('camYaw', (await N('heroYaw')) + Math.PI); await sleep(1200);
  await shot('92_foot_front');
}
if (want('stride')) {
  await N('setInput', {});
  await N('exitCar'); await sleep(2800);
  await N('setInput', { footZ: 1 }); await sleep(1500);
  console.log('trace walk\n  ' + (await N('footTrace', 16)).join('\n  '));
  await N('setInput', { footZ: 1, run: true }); await sleep(1500);
  console.log('trace run\n  ' + (await N('footTrace', 16)).join('\n  '));
  await N('setInput', {});
}
if (want('police')) {
  // police pressure: they should close in and box the car, never shove it over
  await N('heat', 3);
  let minUp = 1, minDist = Infinity;
  const watch = async (label) => { const i = await N('policeInfo'); minUp = Math.min(minUp, i.up); for (const d of i.units) minDist = Math.min(minDist, d); console.log('police', label, JSON.stringify(i)); };
  await N('setInput', { throttle: 0.5 });
  for (let k = 0; k < 6; k++) { await sleep(2000); await watch(`drive${k}`); }
  await shot('80_police_drive');
  await N('setInput', { brake: 1 });
  for (let k = 0; k < 5; k++) { await sleep(1500); await watch(`stopped${k}`); }
  await shot('81_police_stop');
  await N('setInput', {});
  console.log('police summary', JSON.stringify({ minUp, closestCruiser_m: minDist }));
}
if (want('gait')) {
  // get-out / idle / walk / run / get-in frames
  await N('setInput', {});
  await N('exitCar');
  await sleep(500); await shot('70_exit_a');
  await sleep(500); await shot('70_exit_b');
  await sleep(1400);
  await shot('71_idle');
  await N('setInput', { footZ: 1 }); await sleep(1500);
  await shot('72_walk');
  await N('setInput', { footZ: 1, run: true }); await sleep(1500);
  await shot('73_run');
  await N('setInput', {});
  await sleep(800);
  console.log('door', JSON.stringify(await N('toParkedDoor')));
  // walk back to the own car: place at its door
  await N('heroToOwnDoor');
  await sleep(300);
  await N('enterCar');
  await sleep(450); await shot('74_enter_a');
  await sleep(450); await shot('74_enter_b');
  await sleep(450); await shot('74_enter_c');
  await sleep(1200);
  console.log('mode after enter', await N('mode'));
}
if (want('respawn')) {
  // regression: re-creating the Night Courier after another car used to measure its wheels relative to the old car (it flipped)
  await N('setCar', 'car_taxi'); await sleep(500);
  await N('setCar', 'hero'); await sleep(800);
  console.log('respawn carInfo', JSON.stringify((await N('carInfo')).wheelLocal));
  await N('setInput', { throttle: 1 }); await sleep(2000); await N('setInput', {});
  const t = await shot('62_respawn_hero');
  console.log('respawn upright', JSON.stringify({ y: t.pos[1].toFixed(2), kmh: t.kmh.toFixed(0) }));
}
if (want('story')) {
  // play through the campaign with teleports: verifies every mission's steps complete or fail as designed
  const ids = (process.env.STORY || 'm1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12').split(',');
  const S = () => N('storyState');
  for (const id of ids) {
    await N('setInput', {});
    await N('story', id);
    await sleep(700);
    console.log(id, 'start', JSON.stringify(await S()));
    await shot(`60_${id}_a`);
    if (id === 'm2') {
      await N('storyWarp'); await sleep(300);
      await N('exitCar'); await sleep(2600);
      await N('storyWarp', 1.2); await sleep(300);
      await shot(`60_${id}_b`);
      await N('storyInteract'); await sleep(7000);
    } else if (id === 'm4') {
      await N('exitCar'); await sleep(2600);
      console.log(id, 'door', JSON.stringify(await N('toParkedDoor'))); await sleep(300);
      await shot(`60_${id}_b`);
      await N('enterCar'); await sleep(3500);
      console.log(id, 'in coupe', JSON.stringify(await S()));
      await N('storyWarp'); await sleep(500);
    } else if (id === 'm5') {
      await N('setInput', { throttle: 0.45 }); await sleep(2500); await N('setInput', {});
      await shot(`60_${id}_b`);
    } else if (id === 'm6') {
      await N('setInput', { throttle: 1, steer: 0.9, handbrake: true }); await sleep(2500); await N('setInput', {});
      await shot(`60_${id}_b`);
    } else if (id === 'm7') {
      await N('storyWarp'); await sleep(2600);
      console.log(id, 'boarded', JSON.stringify(await S()));
      await N('storyWarp'); await sleep(1200);
      await shot(`60_${id}_b`);
    } else if (id === 'm8') {
      await N('setInput', { throttle: 1 }); await sleep(1500); await N('setInput', {});
      await shot(`60_${id}_b`);
      for (let g = 0; g < 8; g++) { await N('storyWarp'); await sleep(200); }
    } else if (id === 'm11') {
      await sleep(4000);
      await shot(`60_${id}_b`);
    } else {
      for (let k = 0; k < 5; k++) {
        const st = await S();
        if (st.state !== 'run' || !st.target) break;
        await N('storyWarp'); await sleep(500);
        if (k === 0) await shot(`60_${id}_b`);
      }
    }
    await sleep(800);
    const end = await S();
    console.log(id, 'end', JSON.stringify(end));
    await shot(`60_${id}_z`);
  }
}
if (want('converse')) {
  // NPC conversation with a stand-in for /api/talk (no API key needed): checks the two-shot camera,
  // look-at, the panel, suggested replies, the 'end' action and the offline fallback.
  let brainUp = true;
  const seen = [];
  await page.route('**/api/talk', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    seen.push(body);
    if (!brainUp) return route.fulfill({ status: 503, contentType: 'application/x-ndjson', body: JSON.stringify({ t: 'error', code: 'no_key' }) + '\n' });
    const bye = /bye/i.test(body.say || '');
    const line = body.say ? (bye ? 'Yeah, yeah. Stay dry, courier.' : `Work? Ask Mara at the night market. Tell her ${body.persona.name.split(' ')[0]} sent you.`) : `Hm? You lost, courier? I am ${body.persona.name}.`;
    const reply = { line, emotion: bye ? 'neutral' : 'wary', gesture: bye ? 'wave' : 'shrug', action: bye ? 'end' : 'none', replies: bye ? [] : ['Thanks, I owe you.', 'Where is the market?', 'Bye then.'], remember: 'asked about work' };
    const text = JSON.stringify(reply);
    const deltas = (text.match(/.{1,9}/gs) || []).map((c) => JSON.stringify({ t: 'delta', text: c })).join('\n');
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: deltas + '\n' + JSON.stringify({ t: 'done', reply }) + '\n' });
  });
  await N('setInput', {});
  await sleep(300);
  if ((await N('mode')) === 'drive') { await N('exitCar'); await sleep(2200); }
  const pp = await N('nearestPed');
  if (!pp) console.log('converse: no pedestrian nearby');
  else {
    await N('heroTo', pp[0] + 1.3, pp[2] + 0.5); await sleep(400);
    await N('talk'); await sleep(2500);
    let c = await N('conv');
    console.log('converse open', JSON.stringify({ active: c.active, name: c.name, tag: c.tag, line: c.line, replies: c.replies }));
    console.log('persona', JSON.stringify(c.persona));
    await shot('90_conv_open');
    await N('convSay', 'Got any work for a courier?'); await sleep(2500);
    c = await N('conv');
    console.log('converse reply', JSON.stringify({ line: c.line, replies: c.replies }));
    await shot('91_conv_reply');
    const last = seen.at(-1);
    console.log('request sent', JSON.stringify({ say: last.say, history: last.history.length, facts: last.facts }));
    await N('convSay', 'Bye then.'); await sleep(5000);
    c = await N('conv');
    console.log('after bye: active', c.active, 'hero busy', c.heroBusy);
    await shot('92_conv_end');
    // offline: the server says it has no key -> recorded lines
    brainUp = false;
    const pp2 = await N('nearestPed');
    if (pp2) { await N('heroTo', pp2[0] + 1.3, pp2[2] + 0.5); await sleep(400); await N('talk'); await sleep(2000); c = await N('conv'); console.log('offline', JSON.stringify({ active: c.active, name: c.name, tag: c.tag, line: c.line, replies: c.replies })); await shot('93_conv_offline'); await N('convLeave'); }
    console.log('sample personas', JSON.stringify((await N('personaSample', 4)).map((p) => `${p.name}, ${p.age}, ${p.job}; ${p.mood}; ${p.speech}`)));
  }
}
if (want('cams')) {
  await N('camMode', 'hood');
  await sleep(1500);
  await shot('10_hood');
  await N('camMode', 'far');
  await sleep(1500);
  await shot('11_far');
  await N('camMode', 'chase');
}
if (want('perf')) {
  for (const q of ['low', 'med', 'high']) {
    await N('quality', q);
    await sleep(4000);
    await shot(`12_perf_${q}`);
  }
}
fs.writeFileSync(path.join(out, 'console.txt'), errors.join('\n'));
console.log(`console errors/warnings: ${errors.length}`);
errors.slice(0, 20).forEach((e) => console.log('  ', e.slice(0, 300)));
await browser.close();
