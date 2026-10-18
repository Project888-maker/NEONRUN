// NPC brain: persona cards are stable and varied, the server function streams a validated reply
// from the model, refuses foreign origins, rate-limits, and the client parses the stream.
import { makePersona } from '../src/npc/persona';
import { buildUserMessage, sanitizeRequest, normalizeReply, WORLD_RULES, type TalkRequest } from '../src/npc/protocol';
import { handleTalk, type StreamClient } from '../api/talk';
import { Brain, partialLine, finishedLine } from '../src/npc/brain';
import { handleVoice } from '../api/voice';
import { handleStt } from '../api/stt';
import { voiceFor } from '../src/npc/persona';
import { ALL_VOICES } from '../src/npc/protocol';

const fail = (m: string) => { console.error('FAIL', m); process.exit(1); };
const ok = (c: unknown, m: string) => { if (!c) fail(m); };

// personas: same id -> same person; many ids -> many different people
{
  const a = makePersona(7, 'ped_nurse', 'neon'), b = makePersona(7, 'ped_nurse', 'neon');
  ok(JSON.stringify(a) === JSON.stringify(b), 'persona not deterministic');
  const names = new Set<string>(), cards = new Set<string>();
  for (let i = 1; i <= 200; i++) { const p = makePersona(i, 'ped_punk', 'backstreets'); names.add(p.name); cards.add(`${p.job}|${p.mood}|${p.quirk}|${p.speech}`); }
  console.log(`personas: ${names.size} names, ${cards.size} distinct job/mood/quirk/speech combos in 200 punks`);
  ok(names.size > 60 && cards.size > 150, 'personas too repetitive');
  ok(makePersona(3, 'ped_elder', 'docks').age >= 68, 'elder age range');
}

// prompt: the cached part is long enough to cache, the per-person part carries the card
{
  ok(WORLD_RULES.length > 2500, 'world rules too short to be worth caching');
  const req: TalkRequest = { persona: makePersona(1, 'ped_vendor', 'neon'), facts: ['Place: Neon District'], history: [{ who: 'courier', text: 'Hey' }], say: 'Got any soup?', notes: [] };
  const msg = buildUserMessage(req);
  ok(msg.includes(req.persona.name) && msg.includes('Got any soup?') && msg.includes('Neon District'), 'user message missing parts');
}

// sanitising untrusted input
{
  ok(sanitizeRequest(null) === null && sanitizeRequest({ persona: {} }) === null, 'accepted junk');
  const r = sanitizeRequest({ persona: { ...makePersona(2, 'ped_suit', 'downtown'), name: 'x'.repeat(500) }, history: Array(50).fill({ who: 'npc', text: 'y'.repeat(900) }), say: 'z'.repeat(999), facts: Array(40).fill('f') })!;
  ok(r.persona.name.length === 40 && r.history.length === 12 && r.history[0].text.length === 300 && r.say!.length === 240 && r.facts.length === 10, 'limits not applied');
  const n = normalizeReply({ line: ' Hi ', emotion: 'ecstatic', gesture: 'moonwalk', action: 'explode', replies: ['a', 'b', 'c', 'd'], remember: 3 })!;
  ok(n.line === 'Hi' && n.emotion === 'neutral' && n.gesture === 'talk' && n.action === 'none' && n.replies.length === 3 && n.remember === '', 'reply not normalised');
}

// partial line extraction while streaming
{
  ok(partialLine('{"line":"Hello the') === 'Hello the', 'partial 1');
  ok(partialLine('{"line":"She said \\"no') === 'She said "no', 'partial escape');
  ok(partialLine('{"line":"ab\\') === 'ab', 'partial trailing backslash');
  ok(partialLine('{"emo') === '', 'partial none');
  ok(finishedLine('{"line":"Hi there') === null && finishedLine('{"line":"Hi \\"you\\"","emo') === 'Hi "you"', 'finished line');
}

// server function with a fake model client
const reply = { line: 'Two credits, friend. Best broth on the strip.', emotion: 'friendly', gesture: 'talk', action: 'none', replies: ['Make it a large.', 'What is in it?', 'Two? Robbery.'], remember: 'likes soup' };
const fakeClient = (text: string, stop = 'end_turn'): StreamClient & { last?: any } => {
  const c: any = {
    messages: {
      stream(body: any) {
        c.last = body;
        const chunks = text.match(/.{1,7}/gs) ?? [];
        const it = (async function* () { for (const ch of chunks) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ch } }; })();
        return Object.assign(it, { finalMessage: async () => ({ stop_reason: stop, content: [{ type: 'text', text }] }) });
      },
    },
  };
  return c;
};
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('http://game.test/api/talk', { method: 'POST', headers: { 'content-type': 'application/json', host: 'game.test', ...headers }, body: JSON.stringify(body) });
const req: TalkRequest = { persona: makePersona(5, 'ped_vendor', 'neon'), facts: ['Place: Neon District'], history: [], say: 'Smells good.', notes: [] };
const readAll = async (r: Response) => (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
{
  const c = fakeClient(JSON.stringify(reply));
  const evs = await readAll(await handleTalk(post(req, { 'x-forwarded-for': '1.1.1.1' }), c));
  const done = evs.find((e) => e.t === 'done');
  ok(evs.filter((e) => e.t === 'delta').length > 3 && done?.reply.line === reply.line, 'stream / done event wrong');
  ok(c.last.model === 'claude-haiku-5-5' && c.last.system[0].cache_control?.type === 'ephemeral' && c.last.output_config.format.type === 'json_schema' && c.last.thinking.type === 'disabled', 'request shape wrong');
  console.log('server: streamed', evs.length - 1, 'deltas then a validated reply');

  const refused = await readAll(await handleTalk(post(req, { 'x-forwarded-for': '1.1.1.2' }), fakeClient('', 'refusal')));
  ok(refused.at(-1).t === 'error' && refused.at(-1).code === 'refusal', 'refusal not reported');
  const noKey = await handleTalk(post(req), null);
  ok(noKey.status === 503 && (await readAll(noKey))[0].code === 'no_key', 'no key not reported');
  const foreign = await handleTalk(post(req, { origin: 'https://evil.example' }), c);
  ok(foreign.status === 403, 'foreign origin allowed');
  const bad = await handleTalk(post({ hello: 1 }, { 'x-forwarded-for': '1.1.1.3' }), c);
  ok(bad.status === 400, 'bad body accepted');
  let limited = 0;
  for (let i = 0; i < 45; i++) if ((await handleTalk(post(req, { 'x-forwarded-for': '9.9.9.9' }), c)).status === 429) limited++;
  ok(limited === 5, `rate limit: ${limited} of 45 limited, expected 5`);
  console.log('server: no key -> 503, foreign origin -> 403, bad body -> 400, 41st line in 5 min -> 429');
}

// client brain end to end against the handler (fetch stubbed to call it in-process)
{
  const c = fakeClient(JSON.stringify(reply));
  (globalThis as any).fetch = async (_u: string, init: RequestInit) => handleTalk(new Request('http://game.test/api/talk', { ...init, headers: { ...(init.headers as any), host: 'game.test', 'x-forwarded-for': '2.2.2.2' } }), c);
  const partials: string[] = [];
  const brain = new Brain('/api/talk', () => ({ ped_vendor: ['Noodles!', 'Soup!', 'Bye now.'] }));
  const res = await brain.ask(req, 'ped_vendor', (p) => partials.push(p));
  ok(!res.offline && res.reply.line === reply.line && partials.length > 2 && reply.line.startsWith(partials[0]), 'client did not stream the line');
  console.log(`client: line appeared in ${partials.length} steps ("${partials[0]}" ... )`);
  // no key: falls back to the recorded lines and stops asking the server
  (globalThis as any).fetch = async (_u: string, init: RequestInit) => handleTalk(new Request('http://game.test/api/talk', { ...init, headers: { ...(init.headers as any), host: 'game.test' } }), null);
  const off = await brain.ask(req, 'ped_vendor', () => {});
  ok(off.offline && ['Noodles!', 'Soup!', 'Bye now.'].includes(off.reply.line) && brain.offlineReason === 'no_key', 'offline fallback wrong');
  console.log('client: no key -> offline recorded lines');
}
// voices: every persona maps to an allowed stock voice, and different people get different voices
{
  const names = new Set<string>();
  for (const type of ['ped_punk', 'ped_suit', 'ped_elder', 'ped_worker', 'ped_nurse']) for (let i = 1; i <= 30; i++) {
    const v = voiceFor(makePersona(i, type, 'neon'), type);
    ok(ALL_VOICES.includes(v.name) && v.speed >= 0.85 && v.speed <= 1.15, `voice ${v.name} ${v.speed}`);
    names.add(v.name);
  }
  ok(names.size >= 10, `only ${names.size} distinct voices`);
  console.log(`voices: ${names.size} distinct stock voices across 150 people`);
}

// voice endpoint with a fake fal
{
  const calls: string[] = [];
  const fakeFetch = (async (u: string, init?: RequestInit) => {
    calls.push(String(u));
    if (String(u).startsWith('https://fal.run/')) return new Response(JSON.stringify({ audio: { url: 'https://cdn.test/a.mp3' } }), { status: 200 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;
  const get = (q: string, h: Record<string, string> = {}) => new Request(`http://game.test/api/voice?${q}`, { headers: { 'x-forwarded-for': '7.7.7.7', ...h } });
  const r = await handleVoice(get('v=Jessica&t=Hello%20there&s=1.05'), 'k', fakeFetch);
  ok(r.status === 200 && r.headers.get('content-type') === 'audio/mpeg' && (r.headers.get('cache-control') ?? '').includes('s-maxage') && (await r.arrayBuffer()).byteLength === 3, 'voice ok path');
  ok(calls[0].includes('elevenlabs/tts/turbo'), 'voice model');
  ok((await handleVoice(get('v=Jessica&t=hi'), undefined, fakeFetch)).status === 503, 'voice no key');
  ok((await handleVoice(get('v=Morgan&t=hi'), 'k', fakeFetch)).status === 400, 'voice not in allowlist');
  ok((await handleVoice(get(`v=Jessica&t=${'x'.repeat(400)}`), 'k', fakeFetch)).status === 400, 'voice text too long');
  ok((await handleVoice(get('v=Jessica&t=hi', { 'sec-fetch-site': 'cross-site' }), 'k', fakeFetch)).status === 403, 'voice cross-site');
  console.log('voice endpoint: audio with CDN caching; no key 503, unknown voice / long text 400, cross-site 403');
}
// speech-to-text endpoint with a fake fal (no profanity masking on our side)
{
  let sent: any = null;
  const fake = (async (_u: string, init?: RequestInit) => { sent = JSON.parse(String(init!.body)); return new Response(JSON.stringify({ text: ' Fuck off, I am working. ' }), { status: 200 }); }) as typeof fetch;
  const req = (type: string, bytes = 2000, h: Record<string, string> = {}) => new Request('http://game.test/api/stt', { method: 'POST', headers: { 'content-type': type, host: 'game.test', 'x-forwarded-for': '8.8.8.8', ...h }, body: new Uint8Array(bytes) });
  const r = await handleStt(req('audio/webm;codecs=opus'), 'k', fake);
  const j = await r.json();
  ok(r.status === 200 && j.text === 'Fuck off, I am working.' && sent.audio_url.startsWith('data:audio/webm;base64,') && sent.language_code === 'eng', 'stt ok path');
  ok((await handleStt(req('audio/webm'), undefined, fake)).status === 503, 'stt no key');
  ok((await handleStt(req('text/plain'), 'k', fake)).status === 400, 'stt bad type');
  ok((await handleStt(req('audio/webm', 2_000_000), 'k', fake)).status === 400, 'stt too big');
  ok((await handleStt(req('audio/webm', 2000, { origin: 'https://evil.example' }), 'k', fake)).status === 403, 'stt cross-site');
  console.log('stt endpoint: transcript returned untouched; no key 503, wrong type / too long 400, cross-site 403');
}
console.log('PASS');
