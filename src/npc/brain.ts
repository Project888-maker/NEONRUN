// Client side of the NPC brain: posts to /api/talk and streams the reply. Falls back to the
// pre-recorded street lines when the server has no API key, is rate-limited or unreachable.
import { normalizeReply, type Reply, type TalkEvent, type TalkRequest } from './protocol';

export interface BrainResult { reply: Reply; offline: boolean; error?: string }

/** The "line" string once its closing quote has streamed in, else null. */
export function finishedLine(json: string): string | null {
  const m = /"line"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

/** Pull the (possibly unfinished) "line" string out of streaming JSON text. */
export function partialLine(json: string): string {
  const m = /"line"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(json);
  if (!m) return '';
  let raw = m[1];
  if (raw.endsWith('\\')) raw = raw.slice(0, -1);
  try { return JSON.parse(`"${raw}"`); } catch { return raw.replace(/\\"/g, '"'); }
}

export class Brain {
  /** set after the first "no key" answer so we stop asking the server for this session */
  offlineReason: string | null = null;

  constructor(private endpoint = '/api/talk', private fallbackLines: () => Record<string, string[]> = () => ({})) {}

  async ask(req: TalkRequest, type: string, onLine: (partial: string, done: boolean) => void, signal?: AbortSignal): Promise<BrainResult> {
    if (this.offlineReason) return this.offline(req, type, this.offlineReason);
    let res: Response;
    try {
      res = await fetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      return this.offline(req, type, 'network');
    }
    if (!res.body) return this.offline(req, type, `http ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', shown = '', finished = false;
    let done: Reply | null = null, err: string | undefined;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const lineStr = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!lineStr) continue;
        let ev: TalkEvent;
        try { ev = JSON.parse(lineStr); } catch { continue; }
        if (ev.t === 'delta') {
          text += ev.text;
          if (!finished) {
            const f = finishedLine(text);
            if (f !== null) { finished = true; shown = f; onLine(f, true); }
            else { const p = partialLine(text); if (p && p !== shown) { shown = p; onLine(p, false); } }
          }
        } else if (ev.t === 'done') done = normalizeReply(ev.reply);
        else if (ev.t === 'error') err = ev.code;
      }
      if (end) break;
    }
    if (done) return { reply: done, offline: false };
    if (err === 'no_key') this.offlineReason = 'no_key';
    return this.offline(req, type, err ?? 'upstream');
  }

  /** Pre-recorded fallback: the person's archetype lines, then a polite exit. */
  private offline(req: TalkRequest, type: string, reason: string): BrainResult {
    const lines = this.fallbackLines()[type] ?? [];
    const n = req.history.filter((t) => t.who === 'npc').length;
    const seed = [...req.persona.id].reduce((a, c) => a + c.charCodeAt(0), 0);
    const last = n >= Math.min(2, lines.length - 1);
    const line = reason === 'refusal'
      ? "Let's not talk about that."
      : lines.length ? lines[(seed + n) % lines.length] : 'Sorry, not now.';
    return {
      offline: reason !== 'refusal',
      error: reason,
      reply: {
        line, emotion: 'neutral', gesture: n === 0 ? 'talk' : 'shrug', action: last ? 'end' : 'none',
        replies: last ? [] : ['How is the night treating you?', 'Seen anything strange around here?', 'Relax, I am just passing through.'],
        remember: '',
        relationship: 'same',
      },
    };
  }
}
