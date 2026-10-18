import * as THREE from 'three';
import { av } from '../core/version';

const SFX = ['engine_idle', 'engine_low', 'engine_high', 'boost', 'tire_squeal', 'drift_wet', 'gear_shift', 'horn', 'hit_light', 'hit_heavy', 'hit_metal', 'hit_glass', 'suspension',
  'rain_light', 'rain_heavy', 'rain_roof', 'tire_hiss', 'sirens', 'city_hum', 'neon_buzz', 'steam_vent', 'ui_click', 'ui_hover', 'ui_confirm', 'ui_error', 'mission_start', 'mission_complete',
  'timer_tick', 'timer_warning', 'pickup', 'drone_hum', 'crowd', 'train', 'near_miss', 'cash',
  'footstep_wet', 'footsteps_run', 'door_open', 'door_close', 'carjack', 'body_hit', 'scream', 'siren_close', 'jump_land', 'crowd_panic', 'radio_squelch',
  'checkpoint', 'glass_rattle', 'cheer', 'objective', 'camera_flash'] as const;
export type SfxName = typeof SFX[number];
const VOICES = ['brief_1', 'brief_2', 'brief_3', 'brief_neon', 'brief_docks', 'brief_downtown', 'brief_back', 'pickup', 'ten_left', 'twenty_left', 'success_1', 'success_2', 'fail_1', 'fail_2', 'near_miss_1', 'near_miss_2', 'drone', 'upgrade', 'unlock'] as const;
export type VoiceName = typeof VOICES[number];
export type MusicName = 'menu' | 'chill' | 'drive' | 'urgent' | 'chase' | 'finale';

interface Loop { src: AudioBufferSourceNode; gain: GainNode; panner?: PannerNode; filter?: BiquadFilterNode }

export class AudioSys {
  ctx: AudioContext;
  master: GainNode; sfx: GainNode; music: GainNode; voice: GainNode; amb: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private loops = new Map<string, Loop>();
  private musicEls = new Map<MusicName, { el: HTMLAudioElement; gain: GainNode }>();
  private currentMusic: MusicName | null = null;
  private duck = 1;
  private voiceBusy = 0;
  private spatial: Loop[] = [];
  started = false;
  volumes = { master: 0.9, music: 0.55, sfx: 0.9 };

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.sfx = this.gain(this.master, 0.9);
    this.amb = this.gain(this.sfx, 0.8);
    this.music = this.gain(this.master, 0.55);
    this.voice = this.gain(this.master, 1.0);
  }
  private gain(to: AudioNode, v: number) { const g = this.ctx.createGain(); g.gain.value = v; g.connect(to); return g; }

  async load(onProgress?: (p: number) => void) {
    const all = [...SFX.map((s) => `audio/sfx/${s}.mp3`), ...VOICES.map((v) => `audio/voice/${v}.mp3`)];
    let done = 0;
    await Promise.all(all.map(async (p) => {
      try {
        const r = await fetch(av(`./assets/${p}`));
        const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
        this.buffers.set(p.split('/').pop()!.replace('.mp3', '') + (p.includes('/voice/') ? '@v' : ''), b);
      } catch (e) { console.warn('audio load failed', p, e); }
      onProgress?.(++done / all.length);
    }));
    for (const m of ['menu', 'chill', 'drive', 'urgent', 'chase', 'finale'] as MusicName[]) {
      const el = new Audio(av(`./assets/audio/music/${m}.mp3`));
      el.loop = true;
      el.preload = m === 'menu' ? 'auto' : 'metadata';
      el.crossOrigin = 'anonymous';
      const src = this.ctx.createMediaElementSource(el);
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.music);
      this.musicEls.set(m, { el, gain: g });
    }
  }

  /** Must be called from a user gesture. */
  async start() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.started) return;
    this.started = true;
  }

  setVolumes(v: Partial<typeof this.volumes>) {
    Object.assign(this.volumes, v);
    this.master.gain.value = this.volumes.master;
    this.music.gain.value = this.volumes.music;
    this.sfx.gain.value = this.volumes.sfx;
  }

  play(name: SfxName, opts: { volume?: number; rate?: number; pos?: THREE.Vector3 } = {}) {
    const b = this.buffers.get(name);
    if (!b || this.ctx.state !== 'running') return;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = opts.rate ?? 1;
    const g = this.ctx.createGain();
    g.gain.value = opts.volume ?? 1;
    if (opts.pos) {
      const p = this.panner(opts.pos);
      s.connect(g).connect(p).connect(this.sfx);
    } else s.connect(g).connect(this.sfx);
    s.start();
  }

  private panner(pos: THREE.Vector3) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 6;
    p.maxDistance = 400;
    p.rolloffFactor = 1.4;
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    return p;
  }

  loop(key: string, name: SfxName, volume = 0, bus: GainNode = this.sfx, filter = false): Loop | undefined {
    if (this.loops.has(key)) return this.loops.get(key);
    const b = this.buffers.get(name);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    let f: BiquadFilterNode | undefined;
    if (filter) {
      f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2000;
      src.connect(f).connect(gain).connect(bus);
    } else src.connect(gain).connect(bus);
    src.start(0, Math.random() * b.duration);
    const l = { src, gain, filter: f };
    this.loops.set(key, l);
    return l;
  }

  setLoop(key: string, volume: number, rate?: number, cutoff?: number) {
    const l = this.loops.get(key);
    if (!l) return;
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime(volume, t, 0.05);
    if (rate !== undefined) l.src.playbackRate.setTargetAtTime(rate, t, 0.04);
    if (cutoff !== undefined && l.filter) l.filter.frequency.setTargetAtTime(cutoff, t, 0.05);
  }

  startDriving() {
    this.loop('eng_idle', 'engine_idle', 0, this.sfx, true);
    this.loop('eng_low', 'engine_low', 0, this.sfx, true);
    this.loop('eng_high', 'engine_high', 0, this.sfx, true);
    this.loop('squeal', 'tire_squeal');
    this.loop('drift', 'drift_wet');
    this.loop('hiss', 'tire_hiss');
    this.loop('rain_h', 'rain_heavy', 0.35, this.amb);
    this.loop('rain_l', 'rain_light', 0.25, this.amb);
    this.loop('city', 'city_hum', 0.25, this.amb);
    this.loop('sirens', 'sirens', 0.0, this.amb);
    // spatial emitter pool (neon buzz / steam / crowd)
    for (let i = 0; i < 6; i++) {
      const p = this.panner(new THREE.Vector3(0, -1000, 0));
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.connect(p).connect(this.amb);
      this.spatial.push({ src: null as unknown as AudioBufferSourceNode, gain: g, panner: p });
    }
    this.trainLoop = this.spatialLoop('train', 0.9);
    this.droneLoop = this.spatialLoop('drone_hum', 0);
  }
  trainLoop?: Loop;
  droneLoop?: Loop;
  private spatialLoop(name: SfxName, vol: number): Loop | undefined {
    const b = this.buffers.get(name);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = vol;
    const p = this.panner(new THREE.Vector3(0, -1000, 0));
    p.refDistance = 15;
    src.connect(g).connect(p).connect(this.amb);
    src.start();
    return { src, gain: g, panner: p };
  }
  setPos(l: Loop | undefined, pos: THREE.Vector3, vol?: number) {
    if (!l?.panner) return;
    const t = this.ctx.currentTime;
    l.panner.positionX.setTargetAtTime(pos.x, t, 0.05);
    l.panner.positionY.setTargetAtTime(pos.y, t, 0.05);
    l.panner.positionZ.setTargetAtTime(pos.z, t, 0.05);
    if (vol !== undefined) l.gain.gain.setTargetAtTime(vol, t, 0.2);
  }

  private spatialAssign: string[] = [];
  /** Assign the nearest ambient emitters to the spatial voice pool. */
  updateSpatial(spots: { pos: THREE.Vector3; type: string }[], listener: THREE.Vector3) {
    const near = spots.map((s) => ({ s, d: s.pos.distanceToSquared(listener) })).filter((o) => o.d < 60 * 60).sort((a, b) => a.d - b.d).slice(0, this.spatial.length);
    near.forEach((o, i) => {
      const slot = this.spatial[i];
      const key = `${o.s.type}@${o.s.pos.x.toFixed(0)},${o.s.pos.z.toFixed(0)}`;
      if (this.spatialAssign[i] !== key) {
        this.spatialAssign[i] = key;
        try { slot.src?.stop(); } catch { /* not started */ }
        const name = (o.s.type === 'neon' ? 'neon_buzz' : o.s.type === 'steam' ? 'steam_vent' : 'crowd') as SfxName;
        const b = this.buffers.get(name);
        if (!b) return;
        const src = this.ctx.createBufferSource();
        src.buffer = b; src.loop = true;
        src.connect(slot.gain);
        src.start(0, Math.random() * b.duration);
        slot.src = src;
        slot.panner!.positionX.value = o.s.pos.x; slot.panner!.positionY.value = o.s.pos.y; slot.panner!.positionZ.value = o.s.pos.z;
        slot.gain.gain.value = o.s.type === 'crowd' ? 0.7 : o.s.type === 'steam' ? 0.5 : 0.35;
      }
    });
    for (let i = near.length; i < this.spatial.length; i++) {
      if (this.spatialAssign[i]) { this.spatial[i].gain.gain.value = 0; this.spatialAssign[i] = ''; }
    }
  }

  updateListener(cam: THREE.Camera) {
    const l = this.ctx.listener;
    const p = cam.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02); l.positionY.setTargetAtTime(p.y, t, 0.02); l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02); l.forwardY.setTargetAtTime(f.y, t, 0.02); l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02); l.upY.setTargetAtTime(u.y, t, 0.02); l.upZ.setTargetAtTime(u.z, t, 0.02);
    }
  }

  /** Engine model: crossfade 3 loops by RPM, pitch by RPM, low-pass opens with throttle. */
  updateEngine(rpm: number, throttle: number, speed: number, slip: number, drifting: boolean, boosting: boolean) {
    const w = (x: number, a: number, b: number, c: number, d: number) => Math.max(0, Math.min((x - a) / (b - a), 1, (d - x) / (d - c)));
    const idle = w(rpm, 0, 1, 1600, 2400);
    const low = w(rpm, 1400, 2600, 4200, 5600);
    const high = w(rpm, 4000, 5600, 9000, 9500);
    const load = 0.55 + throttle * 0.45 + (boosting ? 0.15 : 0);
    const cutoff = 900 + throttle * 5200 + (boosting ? 2500 : 0);
    this.setLoop('eng_idle', idle * 0.55 * load, THREE.MathUtils.clamp(rpm / 900, 0.8, 1.9), cutoff);
    this.setLoop('eng_low', low * 0.6 * load, THREE.MathUtils.clamp(rpm / 3000, 0.6, 1.7), cutoff);
    this.setLoop('eng_high', high * 0.65 * load, THREE.MathUtils.clamp(rpm / 6200, 0.65, 1.35), cutoff);
    const sq = THREE.MathUtils.clamp((slip - 0.12) * 2.2, 0, 1) * Math.min(1, speed / 10);
    this.setLoop('squeal', sq * 0.45, 0.9 + sq * 0.2);
    this.setLoop('drift', (drifting ? 0.6 : sq * 0.3) * Math.min(1, speed / 12));
    this.setLoop('hiss', Math.min(1, speed / 35) * 0.5, 0.8 + Math.min(0.5, speed / 80));
  }

  music_(name: MusicName | null, fade = 2.0) {
    if (name === this.currentMusic) return;
    const t = this.ctx.currentTime;
    if (this.currentMusic) {
      const old = this.musicEls.get(this.currentMusic)!;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(0, t, fade / 3);
      const el = old.el;
      setTimeout(() => { if (this.currentMusic !== name || true) { if (old.gain.gain.value < 0.02) el.pause(); } }, fade * 1500);
    }
    this.currentMusic = name;
    if (name) {
      const m = this.musicEls.get(name)!;
      m.el.play().catch(() => {});
      m.gain.gain.cancelScheduledValues(t);
      m.gain.gain.setTargetAtTime(1, t, fade / 3);
    }
  }

  say(name: VoiceName) {
    const b = this.buffers.get(`${name}@v`);
    if (!b || this.ctx.state !== 'running') return;
    if (performance.now() < this.voiceBusy) return;
    this.voiceBusy = performance.now() + b.duration * 1000 + 300;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    // radio-ish dispatcher: slight band-pass already baked; duck music while speaking
    s.connect(this.voice);
    s.start();
    const t = this.ctx.currentTime;
    this.music.gain.setTargetAtTime(this.volumes.music * 0.35, t, 0.1);
    this.music.gain.setTargetAtTime(this.volumes.music, t + b.duration, 0.4);
  }

  private talkCache = new Map<string, Promise<AudioBuffer | null>>();
  /** Street conversation line (assets/audio/talk/<name>.mp3), loaded on demand. Resolves to its duration. */
  async talk(name: string, pos?: THREE.Vector3): Promise<number> {
    if (!this.talkCache.has(name)) {
      this.talkCache.set(name, fetch(av(`./assets/audio/talk/${name}.mp3`)).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b)).catch(() => null));
    }
    const b = await this.talkCache.get(name)!;
    if (!b || this.ctx.state !== 'running') return b ? b.duration : 2;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    const g = this.ctx.createGain();
    g.gain.value = 1.1;
    if (pos) { const p = this.panner(pos); p.refDistance = 3; s.connect(g).connect(p).connect(this.voice); }
    else s.connect(g).connect(this.voice);
    s.start();
    return b.duration;
  }

  private speechSrc: AudioBufferSourceNode | null = null;
  /** Generated conversation speech (mp3 bytes from /api/voice). */
  decodeSpeech(bytes: ArrayBuffer) { return this.ctx.decodeAudioData(bytes); }
  /** Play one voice line, cutting off any line still playing. Resolves when it ends (or is cut off). */
  playSpeech(b: AudioBuffer, pos?: THREE.Vector3): Promise<void> {
    this.stopSpeech();
    if (this.ctx.state !== 'running') return Promise.resolve();
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    const g = this.ctx.createGain();
    g.gain.value = 1.15;
    if (pos) { const p = this.panner(pos); p.refDistance = 3; s.connect(g).connect(p).connect(this.voice); }
    else s.connect(g).connect(this.voice);
    this.speechSrc = s;
    const ended = new Promise<void>((res) => { s.onended = () => { if (this.speechSrc === s) this.speechSrc = null; res(); }; });
    s.start();
    return ended;
  }
  stopSpeech() {
    const s = this.speechSrc;
    this.speechSrc = null;
    try { s?.stop(); } catch { /* not started */ }
  }
  /** Lower the music while people are talking. */
  duckMusic(on: boolean) {
    this.music.gain.setTargetAtTime(this.volumes.music * (on ? 0.3 : 1), this.ctx.currentTime, 0.3);
  }

  sirenLoop?: Loop;
  siren(pos: THREE.Vector3 | null) {
    if (!this.sirenLoop) this.sirenLoop = this.spatialLoop('siren_close', 0);
    this.setPos(this.sirenLoop, pos ?? new THREE.Vector3(0, -999, 0), pos ? 1.2 : 0);
  }

  setRain(v: number) { this.setLoop('rain_h', 0.35 * v); this.setLoop('rain_l', 0.25); }
  sirens(v: number) { this.setLoop('sirens', v); }
}
