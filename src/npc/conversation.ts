// Talking to a pedestrian: the courier speaks (suggested reply, typed or spoken) out loud in his own
// voice, the person answers through the NPC brain in theirs, with look-at, gestures and a two-shot camera.
import * as THREE from 'three';
import type { Person, Anim } from '../world/people';
import { Brain } from './brain';
import { voiceFor, ARCHETYPES } from './persona';
import { HERO_VOICE, type Persona, type Reply, type Turn } from './protocol';

/** What the conversation needs to know about the person being talked to (a Crowd ped). */
export interface Talker { id: number; type: string; p: Person; pos: THREE.Vector3; state: string; t: number; key?: string; prevState?: string }

/** The bits of the game's audio engine used for generated speech. */
export interface SpeechAudio {
  decodeSpeech(bytes: ArrayBuffer): Promise<AudioBuffer>;
  playSpeech(b: AudioBuffer, pos?: THREE.Vector3): Promise<void>;
  stopSpeech(): void;
  duckMusic(on: boolean): void;
}

/** What a person remembers about the courier. */
export interface Memory { history: Turn[]; notes: string[]; rel: number }

export interface ConvHost {
  /** who this is (a regular's fixed card, or one generated from the pedestrian's id) */
  persona(t: Talker): Persona;
  /** memory store: regulars persist across sessions, everyone else for this session */
  recall(p: Persona): Memory;
  remember(p: Persona, m: Memory): void;
  /** the job behind the persona's hook, if they can give it now */
  job(t: Talker, p: Persona): { title: string; pay: number } | null;
  acceptJob(t: Talker, p: Persona): void;
  heroPerson(): Person;
  heroPos(): THREE.Vector3;
  setHeroBusy(on: boolean): void;
  facts(p: Persona, t: Talker): string[];
  alive(t: Talker): boolean;
  flee(t: Talker): void;
  callPolice(t: Talker): void;
  voiceOn(): boolean;
  audio: SpeechAudio;
  onOpen(): void;
  onClose(): void;
}

const $ = (id: string) => document.getElementById(id)!;
// one-off gestures play once and settle back into talking; 'push' (a shove) is never a conversation gesture
const GESTURE_CLIP: Record<string, Anim | null> = { talk: 'talk', shrug: 'shrug', wave: 'wave', nod: 'talk', dismiss: 'shrug', phone: 'phone', none: null };
const ONCE = new Set<Anim>(['shrug', 'wave']);

/** Natural voices from /api/voice (ElevenLabs through fal), cached per line. */
class Voices {
  /** set when the server has no voice key: fall back to the device voice for people */
  unavailable = false;
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  constructor(private audio: SpeechAudio) {}
  get(voice: string, text: string, speed = 1): Promise<AudioBuffer | null> {
    if (this.unavailable) return Promise.resolve(null);
    const key = `${voice}|${speed.toFixed(2)}|${text}`;
    let p = this.cache.get(key);
    if (!p) {
      const q = new URLSearchParams({ v: voice, t: text.slice(0, 320), s: speed.toFixed(2) });
      p = fetch(`/api/voice?${q}`)
        .then(async (r) => {
          if (r.status === 503) { this.unavailable = true; return null; }
          return r.ok ? this.audio.decodeSpeech(await r.arrayBuffer()) : null;
        })
        .catch(() => null);
      this.cache.set(key, p);
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }
}

export class Conversation {
  active: Talker | null = null;
  persona: Persona | null = null;
  private waiting = false;
  private abort: AbortController | null = null;
  private closing = false;
  private turn = 0; // bumps on every courier line; stale async work checks it
  private speakT = 0; // seconds the person is still talking (head motion)
  private heroSpeakT = 0;
  private heroDone: Promise<void> = Promise.resolve();
  private heroTalking = false;
  private pendingLine = '';
  private cam = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camInit = false;
  private recog: any = null;
  brain: Brain;
  voices: Voices;

  constructor(private host: ConvHost, lines: () => Record<string, string[]>) {
    this.brain = new Brain('/api/talk', lines);
    this.voices = new Voices(host.audio);
    $('cv-form').addEventListener('submit', (e) => { e.preventDefault(); this.sayTyped(); });
    $('cv-leave').addEventListener('click', () => this.leave());
    const input = $('cv-input') as HTMLInputElement;
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { input.blur(); this.leave(); } });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    this.setupMic();
  }

  personaOf(t: Talker) { return this.host.persona(t); }

  start(t: Talker) {
    if (this.active) return;
    this.active = t;
    const p = (this.persona = this.personaOf(t));
    const m = this.host.recall(p);
    this.closing = false;
    this.camInit = false;
    this.turn++;
    this.heroDone = Promise.resolve();
    this.heroTalking = false;
    this.host.setHeroBusy(true);
    this.host.onOpen();
    this.host.audio.duckMusic(true);
    $('conv').classList.remove('hidden');
    document.body.classList.add('conversing');
    $('cv-name').textContent = m.history.length ? p.name : ARCHETYPES[t.type]?.title ?? 'Stranger';
    $('cv-tag').textContent = '';
    $('cv-you').classList.add('hidden');
    $('cv-job').classList.add('hidden');
    this.setLine('…');
    this.setReplies([]);
    this.request(null);
  }

  /** The courier says something (a suggestion, typed text or speech): out loud, then the person answers. */
  say(text: string) {
    text = text.trim().slice(0, 200);
    if (!text || !this.active || this.waiting || this.closing) return;
    this.turn++;
    this.host.audio.stopSpeech(); // cut the person off if they were still talking
    this.speakT = 0;
    $('cv-you').textContent = text;
    $('cv-you').classList.remove('hidden');
    this.setLine('…');
    this.setReplies([]);
    const hp = this.host.heroPerson();
    hp.play('talk', { fade: 0.25 });
    this.heroDone = this.speakHero(text, this.turn);
    this.request(text); // the person starts thinking while the courier is still talking
  }

  leave() {
    if (!this.active) return;
    this.abort?.abort();
    this.turn++;
    const t = this.active;
    this.active = null;
    this.persona = null;
    this.waiting = false;
    this.host.audio.stopSpeech();
    this.host.audio.duckMusic(false);
    try { speechSynthesis?.cancel?.(); } catch { /* none */ }
    try { this.recog?.abort(); } catch { /* none */ }
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

  /** The courier's own line in his voice; resolves when he has finished saying it. */
  private async speakHero(text: string, turn: number) {
    const est = Math.min(6, 0.6 + text.split(/\s+/).length * 0.32);
    if (!this.host.voiceOn()) { this.heroSpeakT = est; return; }
    this.heroTalking = true;
    try {
      const buf = await this.voices.get(HERO_VOICE, text);
      if (turn !== this.turn || !this.active) return;
      if (!buf) { this.heroSpeakT = est; return; } // no voice service: just the gesture
      this.heroSpeakT = buf.duration;
      await this.host.audio.playSpeech(buf);
    } finally {
      this.heroTalking = false;
      this.heroSpeakT = Math.min(this.heroSpeakT, 0.2);
    }
  }

  private async request(say: string | null) {
    const t = this.active, p = this.persona;
    if (!t || !p) return;
    const turn = this.turn;
    const m = this.host.recall(p);
    const v = voiceFor(p, t.type);
    this.waiting = true;
    $('conv').classList.add('waiting');
    t.p.play('idle', { fade: 0.3 }); // listening
    this.abort = new AbortController();
    this.pendingLine = '';
    let early: Promise<AudioBuffer | null> | null = null;
    let earlyText = '';
    try {
      const res = await this.brain.ask({ persona: p, facts: this.host.facts(p, t), history: m.history, say, notes: m.notes }, t.type, (partial, done) => {
        if (this.active !== t || turn !== this.turn) return;
        // start generating their voice the moment the sentence is complete
        if (done && this.host.voiceOn()) { early = this.voices.get(v.name, partial, v.speed); earlyText = partial; }
        // don't talk over the courier: hold the text until he has finished
        if (this.heroTalking) this.pendingLine = partial;
        else this.setLine(partial);
      }, this.abort.signal);
      if (this.active !== t || turn !== this.turn) return;
      if (say) m.history.push({ who: 'courier', text: say });
      m.history.push({ who: 'npc', text: res.reply.line });
      if (m.history.length > 16) m.history.splice(0, m.history.length - 16);
      if (res.reply.remember) { m.notes.push(res.reply.remember); if (m.notes.length > 6) m.notes.shift(); }
      m.rel = Math.max(-5, Math.min(5, m.rel + (res.reply.relationship === 'warmer' ? 1 : res.reply.relationship === 'colder' ? -1 : 0)));
      this.host.remember(p, m);
      $('cv-name').textContent = p.name;
      $('cv-tag').textContent = `${p.job}${res.offline ? ' · offline lines' : ''}`;
      const audio = !this.host.voiceOn() ? null : earlyText === res.reply.line && early ? early : this.voices.get(v.name, res.reply.line, v.speed);
      this.waiting = false;
      $('conv').classList.remove('waiting');
      await this.heroDone;
      if (this.active !== t || turn !== this.turn) return;
      await this.perform(res.reply, audio, turn);
    } catch {
      /* aborted (left the conversation) */
    } finally {
      if (turn === this.turn) { this.waiting = false; $('conv').classList.remove('waiting'); }
    }
  }

  private async perform(r: Reply, audio: Promise<AudioBuffer | null> | null, turn: number) {
    const t = this.active!;
    this.setLine(r.line);
    const clip = GESTURE_CLIP[r.gesture];
    if (clip && t.p.has(clip) && ONCE.has(clip)) {
      const d = t.p.play(clip, { fade: 0.25, loop: false, restart: true });
      setTimeout(() => { if (this.active === t && turn === this.turn && this.speakT > 0.3) t.p.play('talk', { fade: 0.35 }); }, d * 850);
    } else t.p.play(clip && t.p.has(clip) ? clip : 'talk', { fade: 0.25 });
    const job = r.action === 'offer_job' ? this.host.job(t, this.persona!) : null;
    if (job) this.offerJob(job, t, turn);
    else if (r.action === 'none' || r.action === 'offer_job') this.setReplies(r.replies); // you can answer while they are still talking
    else this.closing = true;
    if (r.action === 'call_police') { t.p.play('phone', { fade: 0.3 }); this.host.callPolice(t); }
    // say it
    const est = Math.min(9, 0.8 + r.line.split(/\s+/).length * 0.33);
    const buf = audio ? await audio : null;
    if (this.active !== t || turn !== this.turn) return;
    if (buf) {
      this.speakT = buf.duration;
      await this.host.audio.playSpeech(buf, t.pos.clone().setY(1.6));
    } else {
      this.speakT = est;
      await this.deviceVoice(r.line, t, est);
    }
    this.speakT = Math.min(this.speakT, 0.2);
    if (this.active !== t || turn !== this.turn) return;
    if (r.action === 'flee') { this.leave(); this.host.flee(t); }
    else if (r.action !== 'none' && r.action !== 'offer_job') setTimeout(() => { if (this.active === t && turn === this.turn) this.leave(); }, 500);
  }

  /** A job is on the table: accept it (the courier agrees, then off you go) or turn it down. */
  private offerJob(job: { title: string; pay: number }, t: Talker, turn: number) {
    $('cv-job').textContent = `Job · ${job.title} · ${job.pay} CR`;
    $('cv-job').classList.remove('hidden');
    const box = $('cv-replies');
    box.innerHTML = '';
    const add = (label: string, cls: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `cv-reply ${cls}`; b.textContent = label; b.dataset.k = String(box.children.length + 1);
      b.addEventListener('click', fn);
      box.appendChild(b);
    };
    add(`Accept · ${job.pay} CR`, 'accept', () => {
      if (this.active !== t || turn !== this.turn || this.closing) return;
      const p = this.persona!;
      this.closing = true;
      this.turn++;
      this.host.audio.stopSpeech();
      $('cv-job').classList.add('hidden');
      $('cv-you').textContent = "Deal. I'm on it.";
      $('cv-you').classList.remove('hidden');
      this.setReplies([]);
      this.host.heroPerson().play('talk', { fade: 0.25 });
      void this.speakHero("Deal. I'm on it.", this.turn).then(() => {
        if (this.active !== t) return;
        this.leave();
        this.host.acceptJob(t, p);
      });
    });
    add('Not now', '', () => { $('cv-job').classList.add('hidden'); this.say("Not tonight, sorry. Maybe another time."); });
  }

  /** Fallback when the voice service is not set up: the device's best-sounding voice. */
  private deviceVoice(text: string, t: Talker, est: number): Promise<void> {
    const wait = new Promise<void>((r) => setTimeout(r, est * 1000));
    if (!this.host.voiceOn() || !this.voices.unavailable || typeof speechSynthesis === 'undefined' || !this.persona) return wait;
    try {
      const v = voiceFor(this.persona, t.type);
      const u = new SpeechSynthesisUtterance(text);
      u.pitch = v.pitch; u.rate = v.rate;
      const all = speechSynthesis.getVoices().filter((x) => /^en/i.test(x.lang));
      const good = all.filter((x) => /natural|neural|online|premium|enhanced|google/i.test(x.name));
      const pool = good.length ? good : all;
      const byGender = pool.filter((x) => (v.gender === 'f' ? /female|aria|jenny|sonia|libby|samantha|zira|emma|ava|michelle/i : /male|guy|ryan|davis|daniel|alex|eric|brian|andrew|christopher/i).test(x.name) && !(v.gender === 'm' && /female/i.test(x.name)));
      const list = byGender.length ? byGender : pool;
      if (list.length) u.voice = list[[...this.persona.id].reduce((a, c) => a + c.charCodeAt(0), 0) % list.length];
      return new Promise<void>((res) => {
        u.onend = () => res(); u.onerror = () => res();
        setTimeout(res, (est + 4) * 1000);
        speechSynthesis.speak(u);
      });
    } catch { return wait; }
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    const t = this.active;
    if (!t) return;
    if (!this.host.alive(t)) { this.leave(); return; }
    t.t = 2; // keep them standing here while we talk
    const hp = this.host.heroPerson();
    const heroPos = this.host.heroPos();
    if (!this.heroTalking && this.pendingLine) { this.setLine(this.pendingLine); this.pendingLine = ''; }
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
    // two-shot: wide of the courier's shoulder, aimed below eye level so both faces sit in the upper
    // half of the frame, clear of the talk panel
    const dir = _c.copy(npcEye).sub(heroEye).setY(0);
    const dist = dir.length() || 1;
    dir.divideScalar(dist);
    const side = _d.set(dir.z, 0, -dir.x); // to the courier's right
    const want = _e.copy(heroEye).addScaledVector(dir, -1.5).addScaledVector(side, 0.95).add(_up.set(0, 0.15, 0));
    const look = _f.copy(heroEye).lerp(npcEye, 0.8).add(_up.set(0, -0.6, 0));
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

  /** Tap to talk: listens until you pause, then the courier says it. Tap again to stop early. */
  private setupMic() {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    const btn = $('cv-mic');
    const input = $('cv-input') as HTMLInputElement;
    if (!SR) { btn.classList.add('hidden'); return; }
    const idle = () => { btn.classList.remove('on'); btn.textContent = 'Speak'; input.placeholder = 'Say something as the courier…'; };
    idle();
    btn.addEventListener('click', () => {
      if (this.recog) { try { this.recog.stop(); } catch { /* */ } return; }
      if (!this.active || this.closing) return;
      const r = new SR();
      r.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
      r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
      let text = '';
      r.onresult = (ev: any) => { text = Array.from(ev.results).map((x: any) => x[0].transcript).join(' '); input.value = text; };
      r.onend = () => { this.recog = null; idle(); if (text.trim()) { input.value = ''; this.say(text); } };
      r.onerror = (ev: any) => {
        this.recog = null; idle();
        if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') input.placeholder = 'Microphone blocked: allow it for this site, or type here';
        else if (ev?.error === 'no-speech') input.placeholder = "Didn't catch that: tap Speak and try again";
      };
      try { r.start(); this.recog = r; btn.classList.add('on'); btn.textContent = 'Listening…'; input.placeholder = 'Listening… speak now'; } catch { idle(); }
    });
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3(), _up = new THREE.Vector3();
function turn(a: number, b: number, k: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * Math.min(1, k);
}
