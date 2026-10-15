import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { City, Spot } from '../world/city';
import { RoadGraph, lineCoord, DISTRICTS, type DistrictId } from '../world/layout';
import type { Hud } from './hud';
import type { AudioSys, MusicName, SfxName } from '../audio/audio';
import { writeSave, type Save } from './progress';
import { beamMesh } from './missions';
import { Drone } from '../world/ambient';
import { Person, lerpAngle } from '../world/people';
import { carMesh } from './police';
import type { CarAsset } from '../vehicle/carModels';
import { RAPIER, groups, GROUP_TRAFFIC, GROUP_CAR, GROUP_WORLD, type Physics } from '../core/physics';
import { LAYER_NO_REFLECT } from '../render/reflector';

// ------------------------------------------------------------------ host interface (implemented in main.ts)
export interface Frame {
  dt: number; t: number;
  pos: THREE.Vector3; vel: THREE.Vector3; speed: number;
  drifting: boolean; driving: boolean; onFoot: boolean; heat: number;
  traffic: { pos: THREE.Vector3 }[];
}

export interface CampaignHost {
  phys: Physics; city: City; graph: RoadGraph; hud: Hud; audio: AudioSys; save: Save; envMap: THREE.Texture;
  cars: Record<string, CarAsset>; people: Record<string, GLTF>;
  /** put the player back in their own car at a road position (leaves foot mode, clears parked cars) */
  placePlayer(x: number, z: number, yaw: number): void;
  /** spawn a parked, enterable car; returns an opaque handle */
  spawnParked(id: string, x: number, z: number, yaw: number): unknown;
  removeParked(handle: unknown): void;
  /** true while the player drives the car behind this handle */
  inCar(handle: unknown): boolean;
  addHeat(n: number): void;
  clearHeat(): void;
  unlock(d: DistrictId): void;
  subtitle(who: string, text: string, dur: number): void;
  droneHit(): void;
  /** results screen closed with a choice */
  choose(c: 'next' | 'retry' | 'free'): void;
}

type Fail = 'time' | 'busted' | 'damage' | 'spotted' | 'lost' | 'comfort';
const FAIL_TEXT: Record<Fail, string> = {
  time: 'Out of time', busted: 'Busted by the police', damage: 'The cargo is destroyed',
  spotted: 'They spotted you', lost: 'You lost them', comfort: 'The client walked out',
};

interface Step {
  prompt: string | (() => string);
  /** objective marker: a beam (pickup/drop colors), a small ground ring (npc/car) or nothing */
  at?: THREE.Vector3 | (() => THREE.Vector3 | null);
  marker?: 'pickup' | 'drop' | 'ring' | 'none';
  /** seconds; 'keep' continues the previous timer */
  time?: number | 'keep' | (() => number);
  start?(): void;
  /** true = step done, a Fail = mission failed, false = keep going */
  check(f: Frame): boolean | Fail;
}

export interface MissionDef {
  id: string; n: number; title: string; district: DistrictId; type: string; desc: string; reward: number;
  unlock: DistrictId[]; music?: MusicName;
  build(c: Campaign): { start: { x: number; z: number; yaw: number }; steps: Step[] };
}

// ------------------------------------------------------------------ geometry helpers
const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const DIR_YAW = { n: Math.PI, s: 0, e: Math.PI / 2, w: -Math.PI / 2 } as const;
/** A right-hand lane start position `along` metres past intersection (i, j) heading in `dir`. */
function laneStart(i: number, j: number, dir: keyof typeof DIR_YAW, along = 24) {
  const yaw = DIR_YAW[dir];
  const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), r = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  const p = V(lineCoord(i), lineCoord(j)).addScaledVector(f, along).addScaledVector(r, 1.75);
  return { x: p.x, z: p.z, yaw };
}
const node = (i: number, j: number) => V(lineCoord(i), lineCoord(j));

/** Lane-following waypoints through a list of intersections (enter/exit points of every segment, right lane). */
function lanePath(pts: THREE.Vector3[]) {
  const out: THREE.Vector3[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const f = b.clone().sub(a).normalize();
    const r = new THREE.Vector3(-f.z, 0, f.x).multiplyScalar(-1); // right of travel direction
    const len = a.distanceTo(b);
    const inset = Math.min(10, len / 3);
    out.push(a.clone().addScaledVector(f, k === 0 ? 0 : inset).addScaledVector(r, 1.75));
    out.push(b.clone().addScaledVector(f, -inset).addScaledVector(r, 1.75));
  }
  return out;
}

// ------------------------------------------------------------------ scripted car (the van you tail)
class ScriptCar {
  root: THREE.Group; wheels: THREE.Object3D[]; body: RAPIER.RigidBody;
  pos: THREE.Vector3; yaw: number; speed = 0; i = 0; spin = 0; done = false;
  constructor(private phys: Physics, private asset: CarAsset, env: THREE.Texture, private path: THREE.Vector3[], public cruise: number) {
    const m = carMesh(asset, env);
    this.root = m.root; this.wheels = m.wheels;
    this.pos = path[0].clone();
    this.yaw = Math.atan2(path[1].x - path[0].x, path[1].z - path[0].z);
    const sp = asset.spec;
    this.body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, 0, this.pos.z));
    phys.world.createCollider(RAPIER.ColliderDesc.cuboid(sp.width * 0.44, sp.height * 0.4, sp.length * 0.48).setTranslation(0, sp.height * 0.42, 0)
      .setCollisionGroups(groups(GROUP_TRAFFIC, GROUP_CAR | GROUP_WORLD)), this.body);
    this.place();
  }
  private place() {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: 0, z: this.pos.z });
    this.body.setNextKinematicRotation({ x: 0, y: Math.sin(this.yaw / 2), z: 0, w: Math.cos(this.yaw / 2) });
  }
  update(dt: number, blockers: THREE.Vector3[]) {
    if (this.done) { this.speed = Math.max(0, this.speed - dt * 6); }
    const tgt = this.path[Math.min(this.i, this.path.length - 1)];
    if (tgt.distanceTo(this.pos) < 5 && this.i < this.path.length) { this.i++; if (this.i >= this.path.length) this.done = true; }
    const to = tgt.clone().sub(this.pos).setY(0);
    let dy = Math.atan2(to.x, to.z) - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += THREE.MathUtils.clamp(dy, -dt * 1.6, dt * 1.6);
    // slow for corners and for anything right in front
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    let want = this.done ? 0 : this.cruise * Math.max(0.35, 1 - Math.abs(dy) * 1.1);
    for (const b of blockers) {
      const rel = b.clone().sub(this.pos).setY(0);
      const ahead = rel.dot(fwd), side = Math.abs(rel.dot(new THREE.Vector3(fwd.z, 0, -fwd.x)));
      if (ahead > 0 && ahead < 11 && side < 2.2) want = 0;
    }
    this.speed = THREE.MathUtils.lerp(this.speed, want, Math.min(1, dt * (want < this.speed ? 2.5 : 0.9)));
    this.pos.addScaledVector(fwd, this.speed * dt);
    this.spin += (this.speed / this.asset.spec.wheelRadius) * dt;
    this.wheels.forEach((w, k) => w.rotation.set(this.spin, k < 2 ? THREE.MathUtils.clamp(dy, -0.5, 0.5) : 0, 0, 'YXZ'));
    this.place();
  }
  dispose() { this.root.removeFromParent(); this.phys.world.removeRigidBody(this.body); }
}

/** Glowing half-ring checkpoint arch spanning the road. */
function gateMesh() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.15, 2.4, 3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const arc = new THREE.Mesh(new THREE.TorusGeometry(8, 0.22, 8, 48, Math.PI), mat);
  const glow = new THREE.Mesh(new THREE.TorusGeometry(8, 0.9, 8, 48, Math.PI), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.5, 0.7), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  g.add(arc, glow);
  g.traverse((o) => o.layers.set(LAYER_NO_REFLECT));
  return { g, mat };
}

// ------------------------------------------------------------------ the campaign runner
export class Campaign {
  active: MissionDef | null = null;
  state: 'idle' | 'run' | 'results' = 'idle';
  group = new THREE.Group();
  route: THREE.Vector3[] = [];
  drones: Drone[] = [];
  elapsed = 0;
  timer: number | null = null;
  steps: Step[] = [];
  idx = 0;
  // per-mission meters
  damage = 0; comfort = 100; driftBank = 0; driftChain = 0; drones_hits = 0;
  private beamP = beamMesh(new THREE.Color(0.13, 0.95, 1));
  private beamD = beamMesh(new THREE.Color(1, 0.18, 0.7));
  private ring: THREE.Mesh;
  private light = new THREE.PointLight(0x21f3ff, 30, 25, 2);
  private cleanup: (() => void)[] = [];
  private npcs: Person[] = [];
  private updaters: ((f: Frame) => void)[] = [];
  private routeT = 0;
  private lineT = 0;
  private lastBeep = 0;
  /** an on-foot interaction offered by the current step (e.g. hand over a package) */
  interaction: { at: THREE.Vector3; label: string; run: () => void } | null = null;
  private story: Record<string, [string, string]> = {};
  private names: Record<string, string> = {};

  constructor(readonly h: CampaignHost) {
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.45, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2, 0.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ring.layers.set(LAYER_NO_REFLECT);
    this.group.add(this.beamP, this.beamD, this.ring, this.light);
    this.hideMarkers();
    fetch('./assets/audio/talk/story.json').then((r) => r.json()).then((j) => { this.story = j.lines; this.names = j.names; }).catch(() => {});
  }

  // ---------------------------------------------------------------- helpers used by mission builders
  /** nearest shopfront drop spot to an anchor point (deterministic) */
  spot(x: number, z: number, d?: DistrictId): Spot {
    let best = this.h.city.spots[0], bd = Infinity;
    for (const s of this.h.city.spots) {
      if (d && s.district !== d) continue;
      const q = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (q < bd) { bd = q; best = s; }
    }
    return best;
  }
  at(s: Spot) { return V(s.x, s.z); }
  /** a point on the sidewalk in front of the spot's shopfront, `along` metres sideways */
  sidewalk(s: Spot, along = 0) { return V(s.x - s.nx * 3, s.z - s.nz * 3).add(new THREE.Vector3(-s.nz, 0, s.nx).multiplyScalar(along)).setY(0.15); }
  routeLen(a: THREE.Vector3, b: THREE.Vector3) {
    const g = this.h.graph;
    const ids = g.route(g.nearestNode(a.x, a.z), g.nearestNode(b.x, b.z));
    let l = 0, prev = a;
    for (const i of ids) { const n = V(g.nodes[i].x, g.nodes[i].z); l += prev.distanceTo(n); prev = n; }
    return l + prev.distanceTo(b);
  }
  say(key: string, pos?: THREE.Vector3) {
    const line = this.story[key];
    return this.h.audio.talk(`story_${key}`, pos).then((d) => { if (line) this.h.subtitle(this.names[line[0]] ?? line[0], line[1], d + 0.4); return d; });
  }
  sfx(n: SfxName, vol = 0.8) { this.h.audio.play(n, { volume: vol }); }
  npc(type: string, pos: THREE.Vector3, yaw: number, anim: 'idle' | 'phone' | 'wave' = 'idle') {
    const g = this.h.people[type];
    if (!g) return null;
    const p = new Person(g, type);
    p.place(pos.x, pos.y, pos.z, yaw);
    p.play(anim, { fade: 0 });
    this.group.add(p.root);
    this.npcs.push(p);
    this.cleanup.push(() => { p.root.removeFromParent(); this.npcs = this.npcs.filter((q) => q !== p); });
    return p;
  }
  onUpdate(fn: (f: Frame) => void) { this.updaters.push(fn); }
  onCleanup(fn: () => void) { this.cleanup.push(fn); }
  spawnDrones(n: number, around: THREE.Vector3) {
    for (let i = 0; i < n; i++) {
      const d = new Drone();
      d.mesh.position.set(around.x + (Math.random() - 0.5) * 90, 28, around.z + (Math.random() - 0.5) * 90);
      this.drones.push(d);
      this.group.add(d.mesh);
    }
  }
  scriptCar(id: string, nodes: THREE.Vector3[], cruise: number) {
    const asset = this.h.cars[id];
    if (!asset) return null;
    const c = new ScriptCar(this.h.phys, asset, this.h.envMap, lanePath(nodes), cruise);
    this.group.add(c.root);
    this.cleanup.push(() => c.dispose());
    return c;
  }
  gates(points: THREE.Vector3[]) {
    const gs = points.map((p, k) => {
      const prev = k === 0 ? p.clone().add(V(0, 40)) : points[k - 1];
      const m = gateMesh();
      m.g.position.copy(p);
      m.g.rotation.y = Math.atan2(p.x - prev.x, p.z - prev.z);
      this.group.add(m.g);
      return m;
    });
    this.cleanup.push(() => gs.forEach((m) => m.g.removeFromParent()));
    return gs;
  }

  // ---------------------------------------------------------------- lifecycle
  start(def: MissionDef) {
    this.stop();
    this.active = def;
    this.state = 'run';
    this.damage = 0; this.comfort = 100; this.driftBank = 0; this.driftChain = 0; this.drones_hits = 0;
    this.elapsed = 0;
    for (const d of def.unlock) this.h.unlock(d);
    this.h.clearHeat();
    const { start, steps } = def.build(this);
    this.h.placePlayer(start.x, start.z, start.yaw);
    this.steps = steps;
    this.idx = -1;
    this.timer = null;
    this.h.hud.banner(def.title, `Mission ${def.n} · ${DISTRICTS[def.district].name}`);
    this.h.audio.play('mission_start', { volume: 0.7 });
    this.h.audio.music_(def.music ?? 'drive');
    setTimeout(() => { if (this.active === def) this.say(`${def.id}_brief`); }, 900);
    this.next();
  }

  stop() {
    for (const f of this.cleanup.splice(0)) f();
    for (const d of this.drones) d.mesh.removeFromParent();
    this.drones = [];
    this.updaters = [];
    this.impactHandlers = [];
    this.interaction = null;
    this.route = [];
    this.hideMarkers();
    this.h.hud.meter(null);
    this.h.hud.setTimer(null);
    this.h.hud.setDist(null);
    this.active = null;
    this.state = 'idle';
  }

  private hideMarkers() { this.beamP.visible = this.beamD.visible = this.ring.visible = false; this.light.intensity = 0; }

  private next() {
    this.idx++;
    if (this.idx >= this.steps.length) { this.finish(true); return; }
    const s = this.steps[this.idx];
    if (s.time !== undefined && s.time !== 'keep') this.timer = typeof s.time === 'function' ? s.time() : s.time;
    else if (s.time === undefined) this.timer = null;
    s.start?.();
    if (this.idx > 0) this.sfx('objective', 0.6);
    this.routeT = 0;
  }

  get target(): THREE.Vector3 | null {
    if (this.state !== 'run') return null;
    const s = this.steps[this.idx];
    if (!s?.at) return null;
    return typeof s.at === 'function' ? s.at() : s.at;
  }
  get markerKind(): 'pickup' | 'drop' { const m = this.steps[this.idx]?.marker; return m === 'drop' ? 'drop' : 'pickup'; }

  /** car crash strength 0..1 (from the contact force events) */
  onImpact(strength: number) {
    if (this.state !== 'run') return;
    for (const f of this.impactHandlers) f(strength);
  }
  impactHandlers: ((s: number) => void)[] = [];

  onBusted() { if (this.state === 'run') this.finish(false, 'busted'); }

  update(f: Frame) {
    for (const n of this.npcs) n.update(f.dt);
    if (this.state !== 'run' || !this.active) return;
    this.elapsed += f.dt;
    const s = this.steps[this.idx];
    // markers
    const tgt = this.target;
    const kind = s.marker ?? 'pickup';
    this.beamP.visible = !!tgt && kind === 'pickup';
    this.beamD.visible = !!tgt && kind === 'drop';
    this.ring.visible = !!tgt && kind === 'ring';
    if (tgt) {
      this.beamP.position.copy(tgt).setY(0); this.beamD.position.copy(tgt).setY(0);
      this.ring.position.copy(tgt).setY(0.2);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(f.t * 5) * 0.3;
      for (const b of [this.beamP, this.beamD]) (b.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms.uTime.value = f.t;
      if (kind !== 'none') {
        // a soft low glow for people markers, the strong beacon light for pickups/drops
        this.light.position.copy(tgt).setY(kind === 'ring' ? 0.6 : 3);
        this.light.color.set(kind === 'drop' ? 0xff2fb4 : kind === 'ring' ? 0xffb347 : 0x21f3ff);
        this.light.intensity = (kind === 'ring' ? 5 : 30) + Math.sin(f.t * 4) * (kind === 'ring' ? 1.5 : 8);
      } else this.light.intensity = 0;
      this.h.hud.setDist(Math.hypot(tgt.x - f.pos.x, tgt.z - f.pos.z));
      this.routeT -= f.dt;
      if (this.routeT <= 0) {
        this.routeT = 1;
        const g = this.h.graph;
        this.route = g.route(g.nearestNode(f.pos.x, f.pos.z), g.nearestNode(tgt.x, tgt.z)).map((i) => V(g.nodes[i].x, g.nodes[i].z));
        this.route.push(tgt.clone());
      }
    } else { this.route = []; this.h.hud.setDist(null); this.light.intensity = 0; }
    this.h.hud.setPrompt(typeof s.prompt === 'function' ? s.prompt() : s.prompt);
    // timer
    if (this.timer !== null) {
      this.timer -= f.dt;
      this.h.hud.setTimer(Math.max(0, this.timer));
      if (this.timer < 10 && Math.floor(this.timer) !== this.lastBeep && this.timer > 0) { this.lastBeep = Math.floor(this.timer); this.sfx(this.timer < 5 ? 'timer_warning' : 'timer_tick', 0.6); }
      if (this.timer <= 0) { this.finish(false, 'time'); return; }
    } else this.h.hud.setTimer(null);
    // drones
    for (const dr of this.drones) {
      dr.update(f.dt, f.pos, f.vel, f.t);
      if (dr.mesh.position.distanceTo(f.pos.clone().add(new THREE.Vector3(0, 1, 0))) < 2.6 && dr.cooldown <= 0) {
        dr.cooldown = 3;
        if (this.timer !== null) this.timer -= 4;
        this.drones_hits++;
        this.h.hud.toast('Drone strike  −4s');
        dr.vel.multiplyScalar(-1.5).add(new THREE.Vector3(0, 12, 0));
        this.h.droneHit();
      }
    }
    for (const u of this.updaters) u(f);
    if (this.state !== 'run') return; // an updater may have failed the mission
    const r = s.check(f);
    if (r === true) this.next();
    else if (r) this.finish(false, r);
  }

  fail(why: Fail) { if (this.state === 'run') this.finish(false, why); }

  private finish(ok: boolean, why?: Fail) {
    const def = this.active!;
    this.state = 'results';
    const timeLeft = this.timer ?? 0;
    for (const d of this.drones) d.mesh.removeFromParent();
    this.drones = [];
    this.hideMarkers();
    this.route = [];
    this.interaction = null;
    this.h.hud.setTimer(null);
    this.h.hud.setDist(null);
    this.h.hud.meter(null);
    const save = this.h.save;
    const res = document.getElementById('results')!;
    res.classList.remove('hidden');
    res.classList.add('story');
    const title = document.getElementById('r-title')!;
    const rows = document.getElementById('r-rows')!;
    const total = document.getElementById('r-total')!;
    const vid = document.getElementById('stinger') as HTMLVideoElement;
    title.textContent = ok ? 'Mission complete' : 'Mission failed';
    this.h.hud.setPrompt(ok ? `${def.title} · complete` : FAIL_TEXT[why ?? 'time']);
    title.classList.toggle('fail', !ok);
    const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
    if (ok) {
      const best = save.story.best[def.id];
      const newBest = best === undefined || this.elapsed < best;
      if (newBest) save.story.best[def.id] = +this.elapsed.toFixed(2);
      const first = !save.story.done.includes(def.id);
      if (first) save.story.done.push(def.id);
      const reward = first ? def.reward : Math.round(def.reward * 0.35);
      const bonus = Math.round(Math.max(0, timeLeft) * 12 + (this.active!.type === 'Fragile' ? (100 - this.damage) * 8 : 0) + (this.active!.type === 'VIP' ? this.comfort * 10 : 0));
      const sum = reward + bonus;
      save.credits += sum;
      rows.innerHTML = `<div>${def.title}</div><div>Time <b>${fmt(this.elapsed)}${newBest ? ' · best' : ''}</b></div><div>${first ? 'Contract' : 'Replay pay'} <b>${reward}</b></div>${bonus ? `<div>Bonus <b>${bonus}</b></div>` : ''}`;
      total.textContent = `+${sum.toLocaleString()} CR`;
      this.h.audio.play('mission_complete');
      setTimeout(() => this.h.audio.play('cash'), 700);
      setTimeout(() => this.say(`${def.id}_win`), 900);
      vid.currentTime = 0; vid.classList.remove('hidden'); vid.play().catch(() => {});
    } else {
      rows.innerHTML = `<div>${def.title}</div><div>${FAIL_TEXT[why ?? 'time']}</div>`;
      total.textContent = '';
      vid.classList.add('hidden');
      this.h.audio.play('ui_error');
      const failLine = why === 'busted' ? 'gen_fail_busted' : this.story[`${def.id}_fail`] ? `${def.id}_fail` : 'gen_fail_time';
      setTimeout(() => this.say(failLine), 500);
    }
    writeSave(save);
    this.h.hud.setCredits(save.credits);
    this.h.audio.music_('chill');
    const acts = document.getElementById('r-actions')!;
    const hasNext = ok && MISSIONS[def.n] !== undefined;
    acts.innerHTML = `${hasNext ? '<button data-r="next" class="primary">Next mission</button>' : ''}<button data-r="retry"${ok ? '' : ' class="primary"'}>${ok ? 'Replay' : 'Retry'}</button><button data-r="free">Free ride</button>`;
    acts.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      this.h.audio.play('ui_click', { volume: 0.6 });
      res.classList.add('hidden'); res.classList.remove('story');
      this.h.choose(b.dataset.r as 'next' | 'retry' | 'free');
    }));
  }

  /** keyboard shortcuts on the results card: Enter = primary, R = retry, Esc/F = free ride */
  resultsKey(code: string) {
    if (this.state !== 'results') return false;
    const acts = document.getElementById('r-actions')!;
    const pick = (r: string) => acts.querySelector<HTMLButtonElement>(`button[data-r="${r}"]`)?.click();
    if (code === 'Enter') { (acts.querySelector<HTMLButtonElement>('button.primary') ?? acts.querySelector('button'))?.click(); return true; }
    if (code === 'KeyR') { pick('retry'); return true; }
    if (code === 'KeyF') { pick('free'); return true; }
    return false;
  }

  // ---------------------------------------------------------------- reusable step builders
  /** drive (or walk) to a point */
  goto(at: THREE.Vector3, prompt: string, o: { marker?: Step['marker']; radius?: number; time?: Step['time']; stop?: boolean; foot?: boolean; car?: unknown; start?: () => void; done?: () => void } = {}): Step {
    return {
      prompt, at, marker: o.marker ?? 'drop', time: o.time, start: o.start,
      check: (f) => {
        if (o.car !== undefined && !this.h.inCar(o.car)) return false;
        if (o.foot && !f.onFoot) return false;
        if (Math.hypot(f.pos.x - at.x, f.pos.z - at.z) > (o.radius ?? 6.5)) return false;
        if (o.stop && f.speed > 3) { this.h.hud.setPrompt('Stop here'); return false; }
        o.done?.();
        return true;
      },
    };
  }
  /** time for a drive from a to b at an average speed, plus slack */
  legTime(a: THREE.Vector3, b: THREE.Vector3, avg = 13, slack = 25) { return Math.round(this.routeLen(a, b) / avg + slack); }
}

// ------------------------------------------------------------------ the twelve story missions
export const MISSIONS: MissionDef[] = [
  {
    id: 'm1', n: 1, title: 'First Shift', district: 'neon', type: 'Delivery', reward: 400, unlock: ['neon'],
    desc: 'Grab a parcel on the strip and drop it across the Neon District.',
    build(c) {
      const start = { x: lineCoord(4) + 1.75, z: -150, yaw: Math.PI };
      const p = c.at(c.spot(-470, -250, 'neon')), d = c.at(c.spot(-180, -560, 'neon'));
      return {
        start, steps: [
          c.goto(p, 'Get to the pickup', { marker: 'pickup', done: () => { c.sfx('pickup'); c.h.audio.say('pickup'); } }),
          c.goto(d, 'Deliver the parcel', { time: () => c.legTime(p, d, 12, 30) }),
        ],
      };
    },
  },
  {
    id: 'm2', n: 2, title: 'Last Few Meters', district: 'neon', type: 'On foot', reward: 600, unlock: ['neon'],
    desc: 'Cars are not welcome at the night market. Walk the package in and hand it to Mara.',
    build(c) {
      const start = laneStart(3, 6, 'n');
      const s = c.spot(-520, -420, 'neon');
      const park = c.at(s);
      const maraPos = c.sidewalk(s, 16);
      const toCurb = Math.atan2(s.nx, s.nz);
      const mara = c.npc('ped_punk', maraPos, toCurb, 'phone');
      let handed = false, talking = false;
      return {
        start, steps: [
          c.goto(park, 'Drive to the night market', { marker: 'pickup', radius: 9 }),
          { prompt: 'Get out of the car  ·  E', check: (f) => f.onFoot, start: () => { c.say('m2_park'); } },
          {
            prompt: () => (talking ? 'Mara' : 'Walk the package to Mara'), at: maraPos, marker: 'ring',
            start: () => {
              c.interaction = {
                at: maraPos, label: 'Hand over the package', run: () => {
                  if (talking) return;
                  talking = true;
                  c.interaction = null;
                  if (mara) { mara.play('talk', { fade: 0.3 }); }
                  c.sfx('pickup', 0.6);
                  c.say('m2_mara', maraPos).then((dur) => setTimeout(() => { handed = true; mara?.play('wave', { fade: 0.3 }); }, dur * 1000 + 300));
                },
              };
            },
            check: (f) => {
              if (mara && f.onFoot) mara.yaw = lerpAngle(mara.yaw, Math.atan2(f.pos.x - maraPos.x, f.pos.z - maraPos.z), Math.min(1, f.dt * 3));
              if (mara) mara.place(maraPos.x, maraPos.y, maraPos.z, mara.yaw);
              return handed;
            },
          },
        ],
      };
    },
  },
  {
    id: 'm3', n: 3, title: 'Handle With Care', district: 'neon', type: 'Fragile', reward: 900, unlock: ['neon', 'backstreets'],
    desc: 'A crate of antique glass lenses for the Backstreets. Every bump cracks the cargo.',
    build(c) {
      const start = laneStart(3, 7, 'e');
      const p = c.at(c.spot(-300, -130, 'neon')), d = c.at(c.spot(-420, 330, 'backstreets'));
      let loaded = false, warned = false;
      c.impactHandlers = [(st) => {
        if (!loaded || st < 0.05) return;
        c.damage = Math.min(100, c.damage + st * 55);
        c.sfx('glass_rattle', 0.5 + st);
        if (c.damage >= 50 && !warned) { warned = true; c.say('m3_half'); }
        if (c.damage >= 100) c.fail('damage');
      }];
      c.onUpdate(() => { if (loaded) c.h.hud.meter('Cargo', 1 - c.damage / 100, c.damage > 60 ? 'var(--magenta)' : 'var(--cyan)', `${Math.round(100 - c.damage)}%`); });
      return {
        start, steps: [
          c.goto(p, 'Pick up the crate', { marker: 'pickup', done: () => { loaded = true; c.sfx('pickup'); } }),
          c.goto(d, 'Deliver the glass · drive smooth', { time: () => c.legTime(p, d, 11, 35) }),
        ],
      };
    },
  },
  {
    id: 'm4', n: 4, title: 'Borrowed Wheels', district: 'backstreets', type: 'Steal', reward: 1100, unlock: ['neon', 'backstreets'],
    desc: 'Someone owes the dispatch a car. Take the orange coupe to the chop garage.',
    build(c) {
      const start = laneStart(2, 10, 'e');
      const s = c.spot(-480, 420, 'backstreets');
      const carAt = c.at(s).add(new THREE.Vector3(s.nx, 0, s.nz).multiplyScalar(-1.2));
      const yaw = Math.atan2(-s.nz, s.nx);
      const coupe = c.h.spawnParked('car_classic', carAt.x, carAt.z, yaw);
      c.onCleanup(() => c.h.removeParked(coupe));
      const g = c.at(c.spot(-130, 700, 'backstreets'));
      return {
        start, steps: [
          { prompt: 'Find the orange coupe and take it', at: () => carAt, marker: 'ring', check: () => c.h.inCar(coupe), start: () => {} },
          c.goto(g, 'Bring the coupe to the chop garage', { car: coupe, time: () => c.legTime(carAt, g, 12, 35), start: () => { c.say('m4_got'); c.h.addHeat(1); } }),
        ],
      };
    },
  },
  {
    id: 'm5', n: 5, title: 'Shadow', district: 'backstreets', type: 'Tail', reward: 1300, unlock: ['neon', 'backstreets'],
    desc: 'Follow the rival crew’s van to its drop. Too close and they see you; too far and they’re gone.',
    build(c) {
      const start = laneStart(2, 12, 'e', 8);
      const nodes = [node(2, 12).add(V(48, 0)), node(5, 12), node(5, 9), node(7, 9), node(7, 14), node(3, 14)];
      const van = c.scriptCar('car_van', nodes, 12);
      let close = 0, far = 0, saidClose = false, saidFar = false;
      c.onUpdate((f) => {
        if (!van) return;
        van.update(f.dt, [...f.traffic.map((t) => t.pos), f.pos]);
        const d = van.pos.distanceTo(f.pos);
        const ok = d >= 15 && d <= 85;
        c.h.hud.meter('Distance', 1 - Math.min(1, Math.abs(d - 45) / 75), d < 15 ? 'var(--magenta)' : d > 85 ? 'var(--amber)' : '#3dff9a', `${Math.round(d)} m`);
        if (d < 15) { close += f.dt; if (!saidClose && close > 0.8) { saidClose = true; c.say('m5_close'); } } else close = Math.max(0, close - f.dt * 0.5);
        if (d > 85) { far += f.dt; if (!saidFar && far > 1.5) { saidFar = true; c.say('m5_far'); } } else far = Math.max(0, far - f.dt);
        if (ok) { saidClose = saidFar = false; }
        if (close > 3 || d < 5) c.fail('spotted');
        else if (far > 7 || d > 180) c.fail('lost');
      });
      return {
        start, steps: [
          { prompt: 'Tail the van · stay out of sight', at: () => van?.pos ?? null, marker: 'none', check: () => !!van?.done && van.speed < 1 },
        ],
      };
    },
  },
  {
    id: 'm6', n: 6, title: 'Sideways', district: 'backstreets', type: 'Drift', reward: 1200, unlock: ['neon', 'backstreets'],
    desc: 'The street crew is betting on you. 2,500 drift points before the clock runs out.',
    build(c) {
      const start = laneStart(3, 11, 'e');
      const GOAL = 2500;
      c.onUpdate((f) => {
        if (f.drifting && f.speed > 9) {
          c.driftChain += f.dt * f.speed * 3;
          c.h.hud.combo(`DRIFT ${Math.round(c.driftChain)}`, 'keep it sideways', 0.6);
        } else if (c.driftChain > 0) {
          if (c.driftChain > 40) { c.driftBank += c.driftChain; c.h.hud.combo(`+${Math.round(c.driftChain)}`, 'banked', 0.6); if (c.driftChain > 350) { c.sfx('cheer', 0.7); if (Math.random() < 0.35) c.say('m6_cheer'); } }
          c.driftChain = 0;
        }
        const total = c.driftBank + c.driftChain;
        c.h.hud.meter('Drift', total / GOAL, 'var(--magenta)', `${Math.round(total)} / ${GOAL}`);
      });
      return { start, steps: [{ prompt: 'Drift! Space + steer', time: 80, check: () => c.driftBank + c.driftChain >= GOAL }] };
    },
  },
  {
    id: 'm7', n: 7, title: 'Executive Ride', district: 'downtown', type: 'VIP', reward: 1600, unlock: ['neon', 'backstreets', 'downtown'],
    desc: 'Drive a demanding executive across Downtown. Every bump costs you his comfort.',
    build(c) {
      const start = laneStart(10, 6, 'n');
      const s = c.spot(330, -430, 'downtown');
      const pick = c.at(s);
      const vipPos = c.sidewalk(s, 0);
      const vip = c.npc('ped_suit', vipPos, Math.atan2(s.nx, s.nz), 'phone');
      const d = c.at(c.spot(650, -130, 'downtown'));
      let boardT = -1, aboard = false, hitCd = 0, outT = -1;
      c.impactHandlers = [(st) => {
        if (!aboard || st < 0.05) return;
        c.comfort = Math.max(0, c.comfort - st * 70);
        if (hitCd <= 0) { hitCd = 6; c.say('m7_vip_hit'); }
        if (c.comfort <= 0) c.fail('comfort');
      }];
      c.onUpdate((f) => {
        hitCd -= f.dt;
        if (aboard) c.h.hud.meter('Comfort', c.comfort / 100, c.comfort < 40 ? 'var(--magenta)' : 'var(--amber)', `${Math.round(c.comfort)}%`);
        if (vip && boardT > 0) {
          boardT -= f.dt;
          const to = f.pos.clone().sub(vip.root.position).setY(0);
          vip.yaw = Math.atan2(to.x, to.z);
          const step = Math.min(to.length(), f.dt * 1.6);
          const np = vip.root.position.clone().add(to.normalize().multiplyScalar(step));
          vip.place(np.x, 0.1, np.z, vip.yaw);
          if (boardT <= 0) { vip.root.visible = false; aboard = true; c.sfx('pickup', 0.5); c.say('m7_vip_in'); }
        }
        if (vip && outT > 0) {
          outT -= f.dt;
          const away = new THREE.Vector3(-s.nx, 0, -s.nz);
          const np = vip.root.position.clone().addScaledVector(away, f.dt * 1.3);
          vip.place(np.x, 0.1, np.z, Math.atan2(away.x, away.z));
        }
      });
      return {
        start, steps: [
          {
            prompt: () => (boardT > 0 ? 'Mr. Ashgrove is getting in…' : 'Pick up Mr. Ashgrove · stop beside him'), at: pick, marker: 'pickup',
            check: (f) => {
              if (aboard) return true;
              if (boardT < 0 && f.driving && Math.hypot(f.pos.x - pick.x, f.pos.z - pick.z) < 9 && f.speed < 2.5) { boardT = 1.8; vip?.play('walk', { fade: 0.2 }); }
              return false;
            },
          },
          c.goto(d, 'Drive him to the tower · smoothly', {
            time: () => c.legTime(pick, d, 12, 30), stop: true,
            done: () => {
              aboard = false;
              if (vip) { const fp = d.clone().add(new THREE.Vector3(-s.nx, 0, -s.nz).multiplyScalar(2)); vip.root.visible = true; vip.place(fp.x, 0.1, fp.z, 0); vip.play('walk', { fade: 0.2 }); outT = 6; }
              c.say('m7_vip_out');
            },
          }),
        ],
      };
    },
  },
  {
    id: 'm8', n: 8, title: 'Glass Canyon', district: 'downtown', type: 'Time trial', reward: 1800, unlock: ['neon', 'backstreets', 'downtown'],
    desc: 'Eight checkpoint gates through the towers. Beat the corporate racers’ record.',
    build(c) {
      const start = laneStart(9, 6, 'n', 20);
      const pts = [node(9, 3), node(11, 3), node(11, 1), node(14, 1), node(14, 4), node(12, 4), node(12, 6), node(10, 6)];
      const gs = c.gates(pts);
      let k = 0;
      const steps: Step[] = pts.map((p, i) => ({
        prompt: `Gate ${i + 1} / ${pts.length}`, at: p, marker: 'none' as const, time: i === 0 ? 100 : 'keep' as const,
        start: () => { gs.forEach((g, j) => { g.mat.color.setRGB(j === i ? 0.15 : 0.6, j === i ? 2.4 : 0.15, j === i ? 3 : 0.9); g.g.visible = j >= i; }); },
        check: (f: Frame) => {
          if (Math.hypot(f.pos.x - p.x, f.pos.z - p.z) > 10) return false;
          k++; c.sfx('checkpoint', 0.9); c.h.hud.combo(`GATE ${k}`, `${(c.timer ?? 0).toFixed(1)} s left`, 0.6);
          return true;
        },
      }));
      return { start, steps };
    },
  },
  {
    id: 'm9', n: 9, title: 'Hot Package', district: 'downtown', type: 'Police', reward: 2000, unlock: ['neon', 'backstreets', 'downtown'], music: 'chase',
    desc: 'The parcel is flagged. The police know what it looks like. Deliver it anyway.',
    build(c) {
      const start = laneStart(10, 2, 'e');
      const p = c.at(c.spot(250, -640, 'downtown')), d = c.at(c.spot(620, -330, 'downtown'));
      return {
        start, steps: [
          c.goto(p, 'Pick up the flagged parcel', { marker: 'pickup', done: () => { c.sfx('pickup'); c.h.addHeat(2); } }),
          c.goto(d, 'Deliver it · don’t get boxed in', { time: () => c.legTime(p, d, 12, 40) }),
        ],
      };
    },
  },
  {
    id: 'm10', n: 10, title: 'Fog Run', district: 'docks', type: 'Drones', reward: 2300, unlock: ['neon', 'backstreets', 'downtown', 'docks'],
    desc: 'A container yard drop under security drones. Keep moving and they cannot lock on.',
    build(c) {
      const start = laneStart(9, 9, 's');
      const p = c.at(c.spot(240, 200, 'docks')), d = c.at(c.spot(620, 620, 'docks'));
      return {
        start, steps: [
          c.goto(p, 'Pick up the container key', { marker: 'pickup', done: () => { c.sfx('pickup'); c.spawnDrones(3, p); c.h.audio.say('drone'); } }),
          c.goto(d, 'Reach the container drop', { time: () => c.legTime(p, d, 12, 35) }),
        ],
      };
    },
  },
  {
    id: 'm11', n: 11, title: 'Clean Getaway', district: 'docks', type: 'Escape', reward: 2600, unlock: ['neon', 'backstreets', 'downtown', 'docks'], music: 'chase',
    desc: 'Someone sold you out. Four stars of heat — lose every one of them.',
    build(c) {
      const start = laneStart(11, 11, 'e');
      return { start, steps: [{ prompt: 'Lose the police · get far away and stay hidden', time: 170, start: () => c.h.addHeat(4), check: (f) => f.heat === 0 && c.elapsed > 3 }] };
    },
  },
  {
    id: 'm12', n: 12, title: 'Last Run', district: 'docks', type: 'Finale', reward: 6000, unlock: ['neon', 'backstreets', 'downtown', 'docks'], music: 'finale',
    desc: 'The core goes through three hands tonight. Three stops, every district, everything at once.',
    build(c) {
      const start = laneStart(4, 6, 'n');
      const p = c.at(c.spot(-300, -420, 'neon'));
      const s1 = c.at(c.spot(-330, 380, 'backstreets'));
      const s2 = c.at(c.spot(330, -330, 'downtown'));
      const s3 = c.at(c.spot(560, 560, 'docks'));
      return {
        start, steps: [
          c.goto(p, 'Pick up the core', { marker: 'pickup', done: () => c.sfx('pickup') }),
          c.goto(s1, 'Stop 1 · Backstreets', { time: () => c.legTime(p, s1, 12, 30) }),
          c.goto(s2, 'Stop 2 · Downtown', { time: () => c.legTime(s1, s2, 12, 40), start: () => { c.say('m12_leg2'); c.h.addHeat(3); } }),
          c.goto(s3, 'Final stop · The Docks', { time: () => c.legTime(s2, s3, 12, 40), start: () => { c.say('m12_leg3'); c.spawnDrones(2, s2); } }),
        ],
      };
    },
  },
];
