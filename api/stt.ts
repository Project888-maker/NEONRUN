// Vercel function: POST /api/stt (body = a short voice recording) -> { text }.
// Speech-to-text for the courier's spoken lines, without the browser recognizer's profanity masking
// ("f***"). ElevenLabs Scribe through fal; needs FAL_KEY in the project environment.
declare const process: { env: Record<string, string | undefined> };
declare const Buffer: { from(b: ArrayBuffer): { toString(enc: 'base64'): string } };

const MODEL = 'fal-ai/elevenlabs/speech-to-text';
const MAX_BYTES = 1_500_000; // ~15 s of opus
const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 40;
const hits = new Map<string, number[]>();
function limited(ip: string, now = Date.now()) {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  return list.length > MAX_PER_WINDOW;
}
const out = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleStt(req: Request, key: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'POST') return out(405, { error: 'method' });
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (origin && host && new URL(origin).host !== host) return out(403, { error: 'forbidden' });
  if (!key) return out(503, { error: 'no_key' });
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!/^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)$/.test(type)) return out(400, { error: 'bad_request' });
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  if (limited(ip)) return out(429, { error: 'rate' });
  const audio = await req.arrayBuffer();
  if (!audio.byteLength || audio.byteLength > MAX_BYTES) return out(400, { error: 'bad_request' });
  try {
    const r = await fetchImpl(`https://fal.run/${MODEL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Key ${key}` },
      body: JSON.stringify({ audio_url: `data:${type};base64,${Buffer.from(audio).toString('base64')}`, language_code: 'eng', tag_audio_events: false, diarize: false }),
    });
    if (!r.ok) { console.error('stt: fal', r.status, (await r.text()).slice(0, 200)); return out(502, { error: 'upstream' }); }
    const j = (await r.json()) as { text?: string };
    return out(200, { text: (j.text ?? '').trim().slice(0, 300) });
  } catch (e) {
    console.error('stt failed', e);
    return out(502, { error: 'upstream' });
  }
}

export default {
  fetch(req: Request) {
    return handleStt(req, process.env.FAL_KEY);
  },
};
