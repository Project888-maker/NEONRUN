import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { City } from './city';
import { CURB_H, type DistrictId } from './layout';
import { Rng } from './city';

/** Animation names baked by blender/build_people.py */
export type Anim = 'walk' | 'run' | 'idle' | 'jump' | 'enter_car' | 'exit_car' | 'talk' | 'wave' | 'flee' | 'phone' | 'shrug' | 'push' | 'fall';

export const PED_TYPES = ['ped_suit', 'ped_vendor', 'ped_punk', 'ped_worker', 'ped_student', 'ped_elder', 'ped_techwear', 'ped_nurse', 'ped_rider'] as const;
export type PedType = typeof PED_TYPES[number];

/** Which characters appear in which district (weights). */
const DISTRICT_MIX: Record<DistrictId, Partial<Record<PedType, number>>> = {
  neon: { ped_punk: 3, ped_student: 2, ped_techwear: 3, ped_vendor: 2, ped_rider: 2, ped_suit: 1, ped_nurse: 1, ped_elder: 1 },
  backstreets: { ped_vendor: 3, ped_elder: 3, ped_punk: 2, ped_worker: 1, ped_student: 1, ped_rider: 2, ped_nurse: 1 },
  downtown: { ped_suit: 4, ped_nurse: 2, ped_student: 2, ped_techwear: 2, ped_rider: 1 },
  docks: { ped_worker: 5, ped_rider: 1, ped_suit: 1 },
};

/** A rigged, animated human (pedestrian or the hero). */
export class Person {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions = new Map<string, THREE.AnimationAction>();
  current: THREE.AnimationAction | null = null;
  currentName = '';
  yaw = 0;

  constructor(gltf: GLTF, public type: string) {
    this.root = cloneSkinned(gltf.scene);
    this.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.frustumCulled = false; // skinned bounds don't follow the animation
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.envMapIntensity = 0.6;
      }
    });
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
  }

  has(name: string) { return this.actions.has(name); }

  play(name: Anim, opts: { fade?: number; loop?: boolean; speed?: number; restart?: boolean } = {}) {
    const a = this.actions.get(name);
    if (!a) return 0;
    if (this.currentName === name && !opts.restart) { a.timeScale = opts.speed ?? 1; return a.getClip().duration; }
    a.reset();
    a.setLoop(opts.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = opts.loop === false;
    a.timeScale = opts.speed ?? 1;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (this.current && this.current !== a) a.crossFadeFrom(this.current, opts.fade ?? 0.25, false);
    a.play();
    this.current = a;
    this.currentName = name;
    return a.getClip().duration;
  }

  update(dt: number) { this.mixer.update(dt); }

  place(x: number, y: number, z: number, yaw: number) {
    this.root.position.set(x, y, z);
    this.yaw = yaw;
    this.root.rotation.y = yaw;
  }
}

type PedState = 'walk' | 'idle' | 'flee' | 'down' | 'talk' | 'wave' | 'phone';

interface Ped {
  p: Person; type: PedType;
  rect: number; s: number; dir: 1 | -1; speed: number;
  state: PedState; t: number; pos: THREE.Vector3; vel: THREE.Vector3; id: number;
}

/** Sidewalk crowds: pedestrians loop around blocks near the player, stop, chat on phones, flee from cars. */
export class Crowd {
  group = new THREE.Group();
  peds: Ped[] = [];
  private rng = new Rng(4242);
  private pool = new Map<PedType, Person[]>();
  private nextId = 1;
  onHit: (pos: THREE.Vector3, speed: number) => void = () => {};
  onScream: (pos: THREE.Vector3) => void = () => {};

  constructor(private assets: Partial<Record<PedType, GLTF>>, private city: City, public target: number) {}

  get types() { return PED_TYPES.filter((t) => this.assets[t]); }

  private take(type: PedType) {
    const list = this.pool.get(type);
    const p = list?.pop() ?? new Person(this.assets[type]!, type);
    this.group.add(p.root);
    return p;
  }
  private release(ped: Ped) {
    ped.p.root.removeFromParent();
    (this.pool.get(ped.type) ?? this.pool.set(ped.type, []).get(ped.type)!).push(ped.p);
  }

  /** point on a sidewalk rectangle perimeter at arc length s; returns direction too */
  private perim(ri: number, s: number, out: THREE.Vector3) {
    const r = this.city.walkRects[ri];
    const W = r.hw * 2, D = r.hd * 2, P = 2 * (W + D);
    s = ((s % P) + P) % P;
    let dx = 0, dz = 0;
    if (s < W) { out.set(r.x - r.hw + s, CURB_H, r.z - r.hd); dx = 1; }
    else if (s < W + D) { out.set(r.x + r.hw, CURB_H, r.z - r.hd + (s - W)); dz = 1; }
    else if (s < 2 * W + D) { out.set(r.x + r.hw - (s - W - D), CURB_H, r.z + r.hd); dx = -1; }
    else { out.set(r.x - r.hw, CURB_H, r.z + r.hd - (s - 2 * W - D)); dz = -1; }
    return { dx, dz, P };
  }

  private pickType(d: DistrictId): PedType {
    const mix = DISTRICT_MIX[d];
    const avail = this.types.filter((t) => mix[t]);
    if (!avail.length) return this.types[0];
    let r = this.rng.next() * avail.reduce((a, t) => a + (mix[t] ?? 0), 0);
    for (const t of avail) { r -= mix[t] ?? 0; if (r <= 0) return t; }
    return avail[0];
  }

  private spawn(player: THREE.Vector3) {
    const rects = this.city.walkRects;
    for (let tries = 0; tries < 20; tries++) {
      const ri = Math.floor(this.rng.next() * rects.length);
      const r = rects[ri];
      const d = Math.hypot(r.x - player.x, r.z - player.z);
      if (d > 170 || d < 20) continue;
      const density = r.district === 'docks' ? 0.25 : r.district === 'downtown' ? 0.8 : 1;
      if (this.rng.next() > density) continue;
      const s = this.rng.next() * 2 * (r.hw * 2 + r.hd * 2);
      const pos = new THREE.Vector3();
      this.perim(ri, s, pos);
      if (pos.distanceTo(player) < 25) continue;
      const type = this.pickType(r.district);
      const p = this.take(type);
      const ped: Ped = { p, type, rect: ri, s, dir: this.rng.chance(0.5) ? 1 : -1, speed: this.rng.range(1.15, 1.55), state: 'walk', t: this.rng.range(4, 15), pos, vel: new THREE.Vector3(), id: this.nextId++ };
      if (type === 'ped_elder') ped.speed = 0.9;
      p.play('walk', { speed: ped.speed / 1.35 });
      p.mixer.setTime(this.rng.next() * 2);
      this.peds.push(ped);
      return;
    }
  }

  /** Nearest standing pedestrian within r (for talking). */
  nearest(pos: THREE.Vector3, r: number) {
    let best: Ped | null = null, bd = r;
    for (const p of this.peds) {
      if (p.state === 'down' || p.state === 'flee') continue;
      const d = p.pos.distanceTo(pos);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** Make a pedestrian stop and talk, facing the hero. */
  talk(ped: Ped, facing: THREE.Vector3, dur: number) {
    ped.state = 'talk';
    ped.t = dur;
    ped.p.yaw = Math.atan2(facing.x - ped.pos.x, facing.z - ped.pos.z);
    ped.p.play('talk', { fade: 0.3 });
  }

  /** Everyone nearby panics (carjack, crash, police). */
  panic(at: THREE.Vector3, radius: number) {
    for (const p of this.peds) if (p.state !== 'down' && p.pos.distanceTo(at) < radius) this.flee(p, at);
  }
  private flee(p: Ped, from: THREE.Vector3) {
    if (p.state === 'flee') { p.t = Math.max(p.t, 3); return; }
    p.state = 'flee';
    p.t = this.rng.range(4, 7);
    const away = p.pos.clone().sub(from).setY(0);
    if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    away.normalize();
    p.vel.copy(away).multiplyScalar(4.2);
    p.p.play(p.p.has('run') ? 'run' : 'flee', { fade: 0.15, speed: 1.1 });
    if (this.rng.chance(0.35)) this.onScream(p.pos);
  }

  update(dt: number, player: THREE.Vector3, threat: { pos: THREE.Vector3; vel: THREE.Vector3; halfLen: number; halfWid: number; yaw: number; speed: number } | null) {
    // population
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      if (p.pos.distanceTo(player) > 190) { this.release(p); this.peds.splice(i, 1); }
    }
    let guard = 0;
    while (this.peds.length < this.target && guard++ < 3) this.spawn(player);

    const tmp = new THREE.Vector3();
    for (const p of this.peds) {
      p.t -= dt;
      // cars: flee when one is coming at you, get knocked down on contact
      if (threat && p.state !== 'down') {
        const rel = p.pos.clone().sub(threat.pos);
        const fwd = new THREE.Vector3(Math.sin(threat.yaw), 0, Math.cos(threat.yaw));
        const along = rel.dot(fwd), lat = Math.abs(rel.x * fwd.z - rel.z * fwd.x);
        if (Math.abs(along) < threat.halfLen + 0.3 && lat < threat.halfWid + 0.35 && threat.speed > 2.5) {
          p.state = 'down';
          p.t = 7;
          p.vel.copy(threat.vel).multiplyScalar(0.55).setY(0);
          p.p.play('fall', { loop: false, fade: 0.08 });
          this.onHit(p.pos, threat.speed);
          continue;
        }
        if (threat.speed > 5 && along < 14 && along > 0 && lat < 3.5 && p.state !== 'flee') this.flee(p, threat.pos);
        else if (threat.speed > 5 && rel.length() < 5 && p.state !== 'flee') this.flee(p, threat.pos);
      }
      switch (p.state) {
        case 'walk': {
          p.s += p.dir * p.speed * dt;
          const { dx, dz } = this.perim(p.rect, p.s, p.pos);
          const want = Math.atan2(dx * p.dir, dz * p.dir);
          p.p.yaw = lerpAngle(p.p.yaw, want, Math.min(1, dt * 6));
          if (p.t <= 0) {
            const r = this.rng.next();
            p.state = r < 0.45 ? 'idle' : r < 0.8 ? 'phone' : 'wave';
            p.t = this.rng.range(3, 8);
            p.p.play(p.state === 'idle' ? 'idle' : p.state === 'phone' ? 'phone' : 'wave', { fade: 0.4 });
          }
          break;
        }
        case 'idle': case 'phone': case 'wave': case 'talk':
          if (p.t <= 0) { p.state = 'walk'; p.t = this.rng.range(6, 18); if (this.rng.chance(0.3)) p.dir = (p.dir * -1) as 1 | -1; p.p.play('walk', { fade: 0.4, speed: p.speed / 1.35 }); }
          break;
        case 'flee': {
          p.pos.addScaledVector(p.vel, dt);
          p.p.yaw = lerpAngle(p.p.yaw, Math.atan2(p.vel.x, p.vel.z), Math.min(1, dt * 10));
          if (p.t <= 0) {
            // walk on from the nearest point of the home loop
            p.state = 'walk';
            p.t = this.rng.range(4, 10);
            const r = this.city.walkRects[p.rect];
            tmp.set(THREE.MathUtils.clamp(p.pos.x, r.x - r.hw, r.x + r.hw), 0, THREE.MathUtils.clamp(p.pos.z, r.z - r.hd, r.z + r.hd));
            p.s = this.arcOf(p.rect, tmp);
            p.p.play('walk', { fade: 0.4, speed: p.speed / 1.35 });
          }
          break;
        }
        case 'down':
          p.pos.addScaledVector(p.vel, dt);
          p.vel.multiplyScalar(Math.max(0, 1 - dt * 3));
          break;
      }
      const ground = this.onSidewalk(p.pos) ? CURB_H : 0;
      p.p.place(p.pos.x, ground, p.pos.z, p.p.yaw);
      // animation LOD: far crowds update at a lower rate
      const d = p.pos.distanceTo(player);
      if (d < 60 || (this.frame + p.id) % 3 === 0) p.p.update(d < 60 ? dt : dt * 3);
    }
    this.frame++;
  }
  private frame = 0;

  private onSidewalk(pos: THREE.Vector3) {
    for (const r of this.city.walkRects) if (Math.abs(pos.x - r.x) < r.hw + 1.45 && Math.abs(pos.z - r.z) < r.hd + 1.45) return true;
    return false;
  }

  private arcOf(ri: number, pt: THREE.Vector3) {
    const r = this.city.walkRects[ri];
    const W = r.hw * 2, D = r.hd * 2;
    const ex = [Math.abs(pt.z - (r.z - r.hd)), Math.abs(pt.x - (r.x + r.hw)), Math.abs(pt.z - (r.z + r.hd)), Math.abs(pt.x - (r.x - r.hw))];
    const side = ex.indexOf(Math.min(...ex));
    if (side === 0) return pt.x - (r.x - r.hw);
    if (side === 1) return W + (pt.z - (r.z - r.hd));
    if (side === 2) return W + D + ((r.x + r.hw) - pt.x);
    return 2 * W + D + ((r.z + r.hd) - pt.z);
  }

  /** Spawn a one-off person (e.g. a carjacked driver) who falls then runs away. */
  ejectDriver(type: PedType, pos: THREE.Vector3, awayFrom: THREE.Vector3) {
    if (!this.assets[type]) return;
    const p = this.take(type);
    let best = 0, bd = Infinity;
    this.city.walkRects.forEach((r, i) => { const d = Math.hypot(r.x - pos.x, r.z - pos.z); if (d < bd) { bd = d; best = i; } });
    const ped: Ped = { p, type, rect: best, s: 0, dir: 1, speed: 1.4, state: 'down', t: 1.4, pos: pos.clone(), vel: pos.clone().sub(awayFrom).setY(0).normalize().multiplyScalar(1.5), id: this.nextId++ };
    p.yaw = Math.atan2(ped.vel.x, ped.vel.z) + Math.PI;
    p.play('fall', { loop: false, fade: 0.05 });
    this.peds.push(ped);
    setTimeout(() => { if (this.peds.includes(ped)) { ped.state = 'idle'; this.flee(ped, awayFrom); } }, 1400);
  }
}

export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
