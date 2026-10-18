// Vercel function: POST /api/talk. The only place the Anthropic API key lives (project env
// ANTHROPIC_API_KEY); the browser never sees it. Streams one JSON event per line (TalkEvent).
import Anthropic from '@anthropic-ai/sdk';
import { WORLD_RULES, REPLY_SCHEMA, buildUserMessage, sanitizeRequest, normalizeReply, type TalkEvent } from '../src/npc/protocol.js';

declare const process: { env: Record<string, string | undefined> };

const MODEL = 'claude-haiku-5-5';
const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 40; // spoken lines per player IP per 5 minutes
const hits = new Map<string, number[]>();

function limited(ip: string, now = Date.now()) {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  return list.length > MAX_PER_WINDOW;
}

const json = (ev: TalkEvent, status = 200) => new Response(JSON.stringify(ev) + '\n', { status, headers: { 'content-type': 'application/x-ndjson' } });

/** Minimal surface of the SDK client used here, so tests can pass a fake. */
export interface StreamClient {
  messages: { stream: (body: Anthropic.MessageStreamParams) => AsyncIterable<Anthropic.MessageStreamEvent> & { finalMessage(): Promise<Anthropic.Message> } };
}

/** GET /api/talk?check: one real (tiny) model call to confirm the key and model work after a deploy. */
async function healthCheck(req: Request, client: StreamClient | null): Promise<Response> {
  const out = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (!client) return out({ ok: false, reason: 'ANTHROPIC_API_KEY is not set for this deployment' }, 503);
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  if (limited(ip)) return out({ ok: false, reason: 'rate limited' }, 429);
  const t0 = Date.now();
  try {
    const talk = sanitizeRequest({ persona: { id: 'check', name: 'Mei Tanaka', age: 61, job: 'noodle stand owner', district: 'Neon District', traits: { warmth: 0.6, chatty: 0.5 }, mood: 'busy but cheerful', quirk: 'calls everyone kid', goal: 'sell out before dawn', fear: 'the health inspector', speech: 'warm and quick' }, facts: ['Place: Neon District', 'Time: night, raining'], history: [], say: 'Evening! Still open?', notes: [] })!;
    const s = client.messages.stream({
      model: MODEL, max_tokens: 400, thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: REPLY_SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: 'text', text: WORLD_RULES, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUserMessage(talk) }],
    });
    let first = 0;
    for await (const ev of s) if (!first && ev.type === 'content_block_delta') first = Date.now() - t0;
    const msg = await s.finalMessage();
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    let reply = null;
    try { reply = normalizeReply(JSON.parse(text)); } catch { /* reported below */ }
    return out({ ok: !!reply, model: msg.model, stop: msg.stop_reason, firstTokenMs: first, totalMs: Date.now() - t0, usage: msg.usage, reply: reply ?? text.slice(0, 300) });
  } catch (e) {
    return out({ ok: false, reason: e instanceof Anthropic.APIError ? `${e.status} ${e.message}`.slice(0, 300) : String(e).slice(0, 300) }, 502);
  }
}

export async function handleTalk(req: Request, client: StreamClient | null): Promise<Response> {
  if (req.method === 'GET' && new URL(req.url).searchParams.has('check')) return healthCheck(req, client);
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  // only our own pages may call this (the browser always sends Origin on a cross-site POST)
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (origin && host && new URL(origin).host !== host) return new Response('Forbidden', { status: 403 });
  if (!client) return json({ t: 'error', code: 'no_key' }, 503);
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  if (limited(ip)) return json({ t: 'error', code: 'rate' }, 429);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ t: 'error', code: 'bad_request' }, 400); }
  const talk = sanitizeRequest(body);
  if (!talk) return json({ t: 'error', code: 'bad_request' }, 400);

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const send = (ev: TalkEvent) => ctrl.enqueue(enc.encode(JSON.stringify(ev) + '\n'));
      try {
        const s = client.messages.stream({
          model: MODEL,
          max_tokens: 400,
          // a short spoken line: no thinking, low effort, for the fastest first words
          thinking: { type: 'disabled' },
          output_config: { effort: 'low', format: { type: 'json_schema', schema: REPLY_SCHEMA as unknown as Record<string, unknown> } },
          system: [{ type: 'text', text: WORLD_RULES, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: buildUserMessage(talk) }],
        });
        for await (const ev of s) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') send({ t: 'delta', text: ev.delta.text });
        }
        const msg = await s.finalMessage();
        if (msg.stop_reason === 'refusal') { send({ t: 'error', code: 'refusal' }); return; }
        const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        let reply = null;
        try { reply = normalizeReply(JSON.parse(text)); } catch { /* fall through */ }
        send(reply ? { t: 'done', reply } : { t: 'error', code: 'upstream' });
      } catch (e) {
        console.error('talk failed', e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
        send({ t: 'error', code: e instanceof Anthropic.RateLimitError ? 'rate' : 'upstream' });
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}

let client: Anthropic | null | undefined;
export default {
  fetch(req: Request) {
    if (client === undefined) client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ maxRetries: 1, timeout: 20_000 }) : null;
    return handleTalk(req, client);
  },
};
