#!/usr/bin/env node
// NEON RUN fal.ai asset runner.
// Usage: NODE_USE_ENV_PROXY=1 node scripts/fal.mjs [--only <prefix>] [--dry]
// - Reads the asset spec from scripts/assets.mjs
// - Skips anything already present in assets/manifest.json (never regenerates)
// - Enforces the budget (BUDGET_USD) using per-model price estimates
// - Saves outputs to assets/generated/<group>/<name>.<ext>
// Auth: uses FAL_KEY from the environment if set (never hard-coded / committed).
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS, PRICES } from './assets.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'assets/generated');
const MANIFEST = path.join(ROOT, 'assets/manifest.json');
const BUDGET_USD = 25;
const CONCURRENCY = 5;

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const dry = args.includes('--dry');

const manifest = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  : { budget_usd: BUDGET_USD, spent_usd_est: 0, assets: {} };

const save = () => {
  manifest.spent_usd_est = +Object.values(manifest.assets).reduce((s, a) => s + (a.cost_usd_est || 0), 0).toFixed(4);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
};

const headers = { 'Content-Type': 'application/json' };
if (process.env.FAL_KEY) headers.Authorization = `Key ${process.env.FAL_KEY}`;

export function estimate(a) {
  const p = PRICES[a.model];
  if (p === undefined) throw new Error(`No price estimate for ${a.model}`);
  return typeof p === 'function' ? p(a.input) : p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQueue(model, input) {
  const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers, body: JSON.stringify(input) });
  if (!sub.ok) throw new Error(`submit ${model}: ${sub.status} ${await sub.text()}`);
  const { status_url, response_url } = await sub.json();
  for (let i = 0; i < 900; i++) {
    await sleep(i < 10 ? 2000 : 5000);
    const st = await fetch(status_url, { headers });
    const s = await st.json();
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED' || s.error) throw new Error(`job failed: ${JSON.stringify(s).slice(0, 400)}`);
  }
  const res = await fetch(response_url, { headers });
  const j = await res.json();
  if (!res.ok) throw new Error(`result ${model}: ${res.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

// Collect every downloadable file URL in a fal response.
function findFiles(obj, acc = [], key = '') {
  if (!obj || typeof obj !== 'object') return acc;
  if (typeof obj.url === 'string' && /^https?:/.test(obj.url)) {
    acc.push({ url: obj.url, key, content_type: obj.content_type || '', file_name: obj.file_name || '' });
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) findFiles(v, acc, key ? `${key}.${k}` : k);
  return acc;
}

function extFor(f) {
  const fromName = path.extname(f.file_name || new URL(f.url).pathname).toLowerCase();
  if (fromName && fromName.length <= 6) return fromName;
  const ct = f.content_type;
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg')) return '.jpg';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('mp4')) return '.mp4';
  if (ct.includes('mpeg') || ct.includes('mp3')) return '.mp3';
  if (ct.includes('wav')) return '.wav';
  if (ct.includes('gltf')) return '.glb';
  return '.bin';
}

// '@file:<path>' inputs are replaced by data URIs of previously generated files.
function resolveInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.startsWith('@file:')) {
      const f = path.join(ROOT, v.slice(6));
      const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
      out[k] = `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;
    } else out[k] = v;
  }
  return out;
}

async function generate(a) {
  const result = await runQueue(a.model, resolveInput(a.input));
  const files = findFiles(result);
  if (!files.length) throw new Error(`no files in result: ${JSON.stringify(result).slice(0, 300)}`);
  const dir = path.join(OUT, a.group);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  // Prefer the primary output; keep extra files (e.g. 3D textures, preview renders) with a suffix.
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const ext = extFor(f);
    const suffix = i === 0 ? '' : `_${f.key.replace(/[^a-z0-9]+/gi, '_')}`;
    const file = path.join(dir, `${a.name}${suffix}${ext}`);
    const r = await fetch(f.url);
    if (!r.ok) throw new Error(`download ${f.url}: ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    saved.push(path.relative(ROOT, file));
  }
  return { result, saved };
}

async function main() {
  const ready = (a) => Object.values(a.input).every((v) => typeof v !== 'string' || !v.startsWith('@file:') || fs.existsSync(path.join(ROOT, v.slice(6))));
  const todo = ASSETS.filter((a) => !manifest.assets[a.id] && (!only || a.id.startsWith(only)) && ready(a));
  const pending = todo.reduce((s, a) => s + estimate(a), 0);
  const spent = Object.values(manifest.assets).reduce((s, a) => s + (a.cost_usd_est || 0), 0);
  console.log(`assets: ${ASSETS.length} total, ${todo.length} to generate; spent≈$${spent.toFixed(2)}, this run≈$${pending.toFixed(2)}, budget $${BUDGET_USD}`);
  if (spent + pending > BUDGET_USD) {
    console.error(`ABORT: would exceed budget ($${(spent + pending).toFixed(2)} > $${BUDGET_USD})`);
    process.exit(2);
  }
  if (dry) { todo.forEach((a) => console.log(`  ${a.id}  ${a.model}  $${estimate(a).toFixed(3)}`)); return; }

  let i = 0, failed = 0;
  const worker = async () => {
    while (i < todo.length) {
      const a = todo[i++];
      const t0 = Date.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { result, saved } = await generate(a);
          manifest.assets[a.id] = {
            files: saved, model: a.model, prompt: a.input.prompt ?? a.input.text ?? null, input: a.input,
            seed: result.seed ?? a.input.seed ?? null, cost_usd_est: estimate(a),
            created: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
          };
          save();
          console.log(`ok   ${a.id} (${Math.round((Date.now() - t0) / 1000)}s) -> ${saved[0]}`);
          break;
        } catch (e) {
          console.warn(`fail ${a.id} attempt ${attempt}: ${e.message.slice(0, 300)}`);
          if (attempt === 2) failed++;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save();
  console.log(`done. failed=${failed} spent≈$${manifest.spent_usd_est}`);
}

if (process.argv[1] && process.argv[1].endsWith('fal.mjs')) main();
