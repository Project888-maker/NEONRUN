// Talking to a pedestrian: the courier speaks (suggested reply, typed or spoken), the person
// answers through the NPC brain, with look-at, gestures, a two-shot camera and an optional voice.
import * as THREE from 'three';
import type { Person, Anim } from '../world/people';
import { Brain } from './brain';
import { makePersona, voiceFor, ARCHETYPES } from './persona';
import type { Persona, Reply, Turn } from './protocol';

/** What the conversation needs to know about the person being talked to (a Crowd ped). */
export interface Talker { id: number; type: string; p: Person; pos: THREE.Vector3; state: string; t: number }

export interface ConvHost {
  heroPerson(): Person;
  heroPos(): THREE.Vector3;
  setHeroBusy(on: boolean): void;
  district(pos: THREE.Vector3): string;
  facts(): string[];
  alive(t: Talker): boolean;
  flee(t: Talker): void;
  callPolice(t: Talker): void;
  voiceOn(): boolean;
  onOpen(): void;
  onClose(): void;
}

interface Memory { history: Turn[]; notes: string[] }

const $ = (id: string) => document.getElementById(id)!;
const GESTURE_CLIP: Record<string, Anim | null> = { talk: 'talk', shrug: 'shrug', wave: 'wave', nod: 'talk', dismiss: 'push', phone: 'phone', none: null };

export class Conversation {
  active: Talker | null = null;
  persona: Persona | null = null;
  private mem = new Map<string, Memory>();
  private personas = new Map<number, Persona>();
  private waiting = false;
  private abort: AbortController | null = null;
  private closing = 0;
  private speakT = 0; // seconds the NPC is still talking (head motion)
  private heroSpeakT = 0;
  private cam = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camInit = false;
  private recog: any = null;
  brain: Brain;

  constructor(private host: ConvHost, lines: () => Record<string, string[]>) {
    this.brain = new Brain('/api/talk', lines);
    $('cv-form').addEventListener('submit', (e) => { e.preventDefault(); this.sayTyped(); });
    $('cv-leave').addEventListener('click', () => this.leave());
    const input = $('cv-input') as HTMLInputElement;
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { input.blur(); this.leave(); } });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    this.setupMic();
  }

  personaOf(t: Talker) {
    let p = this.personas.get(t.id);
    if (!p) { p = makePersona(t.id, t.type, this.host.district(t.pos)); this.personas.set(t.id, p); }
    if (this.personas.size > 300) this.personas.delete(this.personas.keys().next().value!);
    return p;
  }

  start(t: Talker) {
    if (this.active) return;
    this.active = t;
    const p = (this.persona = this.personaOf(t));
    const m = this.memory(p);
    this.closing = 0;
    this.camInit = false;
    this.host.setHeroBusy(true);
    this.host.onOpen();
    $('conv').classList.remove('hidden');
    document.body.classList.add('conversing');
    $('cv-name').textContent = m.history.length ? p.name : ARCHETYPES[t.type]?.title ?? 'Stranger';
    $('cv-tag').textContent = '';
    $('cv-you').classList.add('hidden');
    this.setLine('…');
    this.setReplies([]);
    this.request(null);
  }

  /** Courier says something (a suggestion chip, typed text or speech). */
  say(text: string) {
    text = text.trim().slice(0, 200);
    if (!text || !this.active || this.waiting || this.closing) return;
    $('cv-you').textContent = text;
    $('cv-you').classList.remove('hidden');
    const hp = this.host.heroPerson();
    hp.play('talk', { fade: 0.25 });
    this.heroSpeakT = Math.min(4, 0.6 + text.length / 16);
    this.request(text);
  }

  leave() {
    if (!this.active) return;
    this.abort?.abort();
    const t = this.active;
    this.active = null;
    this.persona = null;
    this.waiting = false;
    speechSynthesis?.cancel?.();
    t.t = 0.4; // the crowd puts them back on their way
    t.p.look = null; t.p.speak = 0;
    const hp = this.host.heroPerson();
    hp.look = null; hp.speak = 0;
    hp.play('idle', { fade: 0.3 });
    this.host.setHeroBusy(false);
    $('conv').classList.add('hidden');
    document.body.classList.remove('conversing');
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.host.onClose();
  }

  private memory(p: Persona) {
    let m = this.mem.get(p.id);
    if (!m) { m = { history: [], notes: [] }; this.mem.set(p.id, m); }
    return m;
  }

  private async request(say: string | null) {
    const t = this.active, p = this.persona;
    if (!t || !p) return;
    const m = this.memory(p);
    this.waiting = true;
    $('conv').classList.add('waiting');
    this.setReplies([]);
    t.p.play('idle', { fade: 0.3 }); // listening
    this.abort = new AbortController();
    let streamed = false;
    try {
      const res = await this.brain.ask({ persona: p, facts: this.host.facts(), history: m.history, say, notes: m.notes }, t.type, (partial) => {
        if (this.active !== t) return;
        streamed = true;
        this.setLine(partial);
        this.speakT = 1.2;
      }, this.abort.signal);
      if (this.active !== t) return;
      if (say) m.history.push({ who: 'courier', text: say });
      m.history.push({ who: 'npc', text: res.reply.line });
      if (m.history.length > 16) m.history.splice(0, m.history.length - 16);
      if (res.reply.remember) { m.notes.push(res.reply.remember); if (m.notes.length > 6) m.notes.shift(); }
      $('cv-name').textContent = p.name;
      $('cv-tag').textContent = `${p.job}${res.offline ? ' · offline lines' : ''}`;
      this.perform(res.reply, streamed);
    } catch {
      /* aborted (left the conversation) */
    } finally {
      this.waiting = false;
      $('conv').classList.remove('waiting');
    }
  }

  private perform(r: Reply, streamed: boolean) {
    const t = this.active!;
    this.setLine(r.line);
    const clip = GESTURE_CLIP[r.gesture];
    if (clip && t.p.has(clip)) t.p.play(clip, { fade: 0.25 });
    else t.p.play('talk', { fade: 0.25 });
    const dur = this.speak(r.line, t);
    this.speakT = dur;
    if (!streamed) this.speakT = Math.max(this.speakT, 1);
    // the person decides how this goes
    if (r.action === 'flee') { this.closing = 1.2; setTimeout(() => { if (this.active === t) { this.leave(); this.host.flee(t); } }, 1200); return; }
    if (r.action === 'call_police') { this.closing = dur + 0.5; t.p.play('phone', { fade: 0.3 }); this.host.callPolice(t); setTimeout(() => { if (this.active === t) this.leave(); }, (dur + 0.8) * 1000); return; }
    if (r.action === 'end') { this.closing = dur + 0.6; setTimeout(() => { if (this.active === t) this.leave(); }, (dur + 0.9) * 1000); return; }
    this.setReplies(r.replies);
  }

  /** Browser speech for the reply (free, per-persona pitch / rate); returns the speaking time. */
  private speak(text: string, t: Talker) {
    const est = Math.min(9, 0.8 + text.split(/\s+/).length * 0.33);
    if (!this.host.voiceOn() || typeof speechSynthesis === 'undefined' || !this.persona) return est;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = voiceFor(this.persona, t.type);
      u.pitch = v.pitch; u.rate = v.rate; u.volume = 0.95;
      const voices = speechSynthesis.getVoices().filter((x) => /^en/i.test(x.lang));
      if (voices.length) {
        const fem = voices.filter((x) => /female|samantha|victoria|karen|moira|tessa|zira|aria|jenny|libby|sonia|fiona|serena/i.test(x.name));
        const male = voices.filter((x) => /male|daniel|alex|fred|david|mark|guy|ryan|george|arthur|oliver|thomas/i.test(x.name) && !/female/i.test(x.name));
        const pool = (v.gender === 'f' ? fem : male).length ? (v.gender === 'f' ? fem : male) : voices;
        u.voice = pool[[...this.persona.id].reduce((a, c) => a + c.charCodeAt(0), 0) % pool.length];
      }
      u.onend = () => { if (this.active === t) this.speakT = Math.min(this.speakT, 0.2); };
      speechSynthesis.speak(u);
    } catch { /* speech not available */ }
    return est;
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    const t = this.active;
    if (!t) return;
    if (!this.host.alive(t)) { this.leave(); return; }
    t.state = 'talk';
    t.t = 2; // keep them standing here while we talk
    const hp = this.host.heroPerson();
    const heroPos = this.host.heroPos();
    // face each other
    const yawTo = (from: THREE.Vector3, to: THREE.Vector3) => Math.atan2(to.x - from.x, to.z - from.z);
    t.p.yaw = turn(t.p.yaw, yawTo(t.pos, heroPos), dt * 5);
    t.p.root.rotation.y = t.p.yaw;
    hp.yaw = turn(hp.yaw, yawTo(heroPos, t.pos), dt * 5);
    hp.root.rotation.y = hp.yaw;
    const npcEye = _a.copy(t.pos).setY(t.p.root.position.y + 1.6);
    const heroEye = _b.copy(heroPos).setY(hp.root.position.y + 1.65);
    t.p.look = heroEye.clone();
    hp.look = npcEye.clone();
    this.speakT = Math.max(0, this.speakT - dt);
    this.heroSpeakT = Math.max(0, this.heroSpeakT - dt);
    t.p.speak += ((this.speakT > 0 ? 1 : 0) - t.p.speak) * Math.min(1, dt * 6);
    hp.speak += ((this.heroSpeakT > 0 ? 0.8 : 0) - hp.speak) * Math.min(1, dt * 6);
    if (this.speakT <= 0 && !this.waiting && t.p.currentName !== 'idle' && t.p.currentName !== 'phone') t.p.play('idle', { fade: 0.5 });
    if (this.heroSpeakT <= 0 && hp.currentName === 'talk') hp.play('idle', { fade: 0.5 });
    // two-shot: over the courier's shoulder, framing the person's face
    const dir = _c.copy(npcEye).sub(heroEye).setY(0);
    const dist = dir.length() || 1;
    dir.divideScalar(dist);
    const side = _d.set(dir.z, 0, -dir.x); // to the courier's right
    const want = _e.copy(heroEye).addScaledVector(dir, -1.35).addScaledVector(side, 0.55).add(_up.set(0, 0.12, 0));
    const look = _f.copy(heroEye).lerp(npcEye, 0.72).add(_up.set(0, -0.05, 0));
    if (!this.camInit) { this.cam.copy(camera.position); this.camLook.copy(look); this.camInit = true; }
    const k = Math.min(1, dt * 3.5);
    this.cam.lerp(want, k);
    this.camLook.lerp(look, k);
    camera.position.copy(this.cam);
    camera.lookAt(this.camLook);
    camera.fov = THREE.MathUtils.lerp(camera.fov, 42, k);
    camera.updateProjectionMatrix();
  }

  private sayTyped() {
    const input = $('cv-input') as HTMLInputElement;
    const v = input.value;
    input.value = '';
    this.say(v);
  }

  private setLine(text: string) { $('cv-line').textContent = text; }

  private setReplies(list: string[]) {
    const box = $('cv-replies');
    box.innerHTML = '';
    list.forEach((r, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cv-reply';
      b.textContent = r;
      b.dataset.k = String(i + 1);
      b.addEventListener('click', () => this.say(r));
      box.appendChild(b);
    });
  }

  /** 1 / 2 / 3 pick a suggested reply (when not typing). */
  key(code: string) {
    if (!this.active) return false;
    const n = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 }[code];
    if (n === undefined) return false;
    const b = $('cv-replies').children[n] as HTMLButtonElement | undefined;
    b?.click();
    return true;
  }

  /** Push-to-talk speech recognition where the browser has it (Chrome, Edge, Safari). */
  private setupMic() {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    const btn = $('cv-mic');
    if (!SR) { btn.classList.add('hidden'); return; }
    const begin = (e: Event) => {
      e.preventDefault();
      if (this.recog || this.waiting) return;
      const r = new SR();
      r.lang = 'en-US'; r.interimResults = true; r.maxAlternatives = 1;
      let text = '';
      r.onresult = (ev: any) => { text = Array.from(ev.results).map((x: any) => x[0].transcript).join(' '); ($('cv-input') as HTMLInputElement).value = text; };
      r.onend = () => { this.recog = null; btn.classList.remove('on'); if (text.trim()) { ($('cv-input') as HTMLInputElement).value = ''; this.say(text); } };
      r.onerror = () => { this.recog = null; btn.classList.remove('on'); };
      try { r.start(); this.recog = r; btn.classList.add('on'); } catch { /* already running */ }
    };
    const end = () => { try { this.recog?.stop(); } catch { /* */ } };
    btn.addEventListener('pointerdown', begin);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointerleave', end);
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3(), _up = new THREE.Vector3();
function turn(a: number, b: number, k: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * Math.min(1, k);
}
