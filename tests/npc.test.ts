// NPC brain: persona cards are stable and varied, the server function streams a validated reply
// from the model, refuses foreign origins, rate-limits, and the client parses the stream.
import { makePersona } from '../src/npc/persona';
import { buildUserMessage, sanitizeRequest, normalizeReply, WORLD_RULES, type TalkRequest } from '../src/npc/protocol';
import { handleTalk, type StreamClient } from '../api/talk';
import { Brain, partialLine } from '../src/npc/brain';

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
console.log('PASS');
