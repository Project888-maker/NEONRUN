// Vercel function: GET /api/voice?v=<voice>&t=<text>&s=<speed> -> audio/mpeg.
// Natural speech for conversation lines (ElevenLabs Turbo v2.5 through fal). Needs FAL_KEY in the
// project environment. Responses are cached by the CDN, so a repeated line is free and instant.
import { ALL_VOICES } from '../src/npc/protocol.js';

declare const process: { env: Record<string, string | undefined> };

const MODEL = 'fal-ai/elevenlabs/tts/turbo-v2.5';
const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 80; // spoken lines per IP per 5 minutes (courier + people)
const hits = new Map<string, number[]>();
function limited(ip: string, now = Date.now()) {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  return list.length > MAX_PER_WINDOW;
}

const fail = (status: number, code: string) => new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleVoice(req: Request, key: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'GET') return fail(405, 'method');
  // pages on other sites may not use this (browsers mark cross-site requests)
  if (req.headers.get('sec-fetch-site') === 'cross-site') return fail(403, 'forbidden');
  if (!key) return fail(503, 'no_key');
  const u = new URL(req.url);
  const voice = u.searchParams.get('v') ?? '';
  const text = (u.searchParams.get('t') ?? '').replace(/\s+/g, ' ').trim();
  const speed = Math.max(0.8, Math.min(1.2, Number(u.searchParams.get('s')) || 1));
  if (!ALL_VOICES.includes(voice) || !text || text.length > 320) return fail(400, 'bad_request');
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  if (limited(ip)) return fail(429, 'rate');
  try {
    const r = await fetchImpl(`https://fal.run/${MODEL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Key ${key}` },
      body: JSON.stringify({ text, voice, stability: 0.45, similarity_boost: 0.75, speed }),
    });
    if (!r.ok) { console.error('voice: fal', r.status, (await r.text()).slice(0, 200)); return fail(502, 'upstream'); }
    const j = (await r.json()) as { audio?: { url?: string } };
    if (!j.audio?.url) return fail(502, 'upstream');
    const a = await fetchImpl(j.audio.url);
    if (!a.ok) return fail(502, 'upstream');
    return new Response(await a.arrayBuffer(), {
      headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400, s-maxage=2592000, immutable' },
    });
  } catch (e) {
    console.error('voice failed', e);
    return fail(502, 'upstream');
  }
}

export default {
  fetch(req: Request) {
    return handleVoice(req, process.env.FAL_KEY);
  },
};
