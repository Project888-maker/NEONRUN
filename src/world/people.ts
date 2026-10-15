import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { City } from './city';
import { CURB_H, type DistrictId } from './layout';
import { Rng } from './city';
import { poolUniforms, MAX_POOLS } from '../render/groundMaterial';

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

/** Neon light pools (the same ones that light the wet street) also light people, so they sit in the scene. */
function patchPersonMaterial(mat: THREE.MeshStandardMaterial) {
  if (mat.userData.personPatched) return;
  mat.userData.personPatched = true;
  // generated PBR maps can read as chrome under city reflections: keep skin and cloth dielectric
  mat.metalness = Math.min(mat.metalness, 0.15);
  mat.roughness = Math.max(mat.roughness, 0.55);
  mat.envMapIntensity = 0.9;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPoolPos = poolUniforms.uPoolPos;
    sh.uniforms.uPoolCol = poolUniforms.uPoolCol;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uPoolPos[${MAX_POOLS}];\nuniform vec3 uPoolCol[${MAX_POOLS}];`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          vec3 pAcc = vec3(0.0);
          for (int i = 0; i < ${MAX_POOLS}; i++) {
            vec4 lp = uPoolPos[i];
            vec3 lv = (viewMatrix * vec4(lp.xyz, 1.0)).xyz + vViewPosition;
            float d = length(lv);
            float att = clamp(1.0 - d / (lp.w * 1.15), 0.0, 1.0);
            att *= att;
            float wrap = clamp(dot(normal, lv / max(d, 1e-3)) * 0.6 + 0.4, 0.0, 1.0);
            pAcc += uPoolCol[i] * att * wrap;
          }
          // capped so a nearby bright source (car headlights) tints instead of bleaching the character
          reflectedLight.directDiffuse += min(pAcc * 0.35, vec3(0.9)) * diffuseColor.rgb;
        }`);
  };
  mat.needsUpdate = true;
}

let shadowTex: THREE.Texture | null = null;
function contactShadow() {
  if (!shadowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    shadowTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.renderOrder = 1;
  return m;
}

/** Body heading over time for clips that turn the character (get in / out of a car), relative to the idle stance. */
const headingCache = new WeakMap<GLTF, Record<string, number[]>>();
const HEADING_SAMPLES = 48;
function headingTables(gltf: GLTF) {
  let h = headingCache.get(gltf);
  if (h) return h;
  h = {};
  const root = cloneSkinned(gltf.scene);
  let hips: THREE.Object3D | undefined;
  root.traverse((o) => { if (/^hips$/i.test(o.name)) hips = o; });
  const mixer = new THREE.AnimationMixer(root);
  const q = new THREE.Quaternion();
  const sample = (clip: THREE.AnimationClip, t: number) => {
    const a = mixer.clipAction(clip);
    a.play();
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    hips!.getWorldQuaternion(q);
    a.stop();
    return q.clone();
  };
  const idle = gltf.animations.find((c) => c.name === 'idle');
  if (hips && idle) {
    const ref = sample(idle, 0).invert();
    for (const name of ['enter_car', 'exit_car']) {
      const clip = gltf.animations.find((c) => c.name === name);
      if (!clip) continue;
      const out: number[] = [];
      let prev = 0;
      for (let i = 0; i <= HEADING_SAMPLES; i++) {
        const r = sample(clip, (clip.duration * i) / HEADING_SAMPLES).multiply(ref);
        const v = new THREE.Vector3(0, 0, 1).applyQuaternion(r);
        let y = Math.atan2(v.x, v.z);
        while (y - prev > Math.PI) y -= Math.PI * 2; // unwrap so interpolation never spins the long way
        while (y - prev < -Math.PI) y += Math.PI * 2;
        out.push(y); prev = y;
      }
      h[name] = out;
    }
  }
  mixer.stopAllAction();
  headingCache.set(gltf, h);
  return h;
}

/**
 * Natural ground speed (m/s) of a gait clip at timeScale 1, measured the way the ground sees it:
 * how fast the foot that is on the floor (the lower one, near its lowest height) moves backward
 * relative to the hips. A stride-range estimate is wrong for running, where each foot is down for
 * only about a third of the cycle and swings far ahead of where it lands.
 */
const gaitCache = new WeakMap<GLTF, Record<string, number>>();
function gaitSpeeds(gltf: GLTF) {
  let g = gaitCache.get(gltf);
  if (g) return g;
  g = {};
  const root = cloneSkinned(gltf.scene);
  const feet: THREE.Object3D[] = [];
  let hips: THREE.Object3D | undefined;
  root.traverse((o) => { if (/(left|right)foot$/i.test(o.name)) feet.push(o); if (/^hips$/i.test(o.name)) hips = o; });
  const mixer = new THREE.AnimationMixer(root);
  for (const name of ['walk', 'run']) {
    const clip = gltf.animations.find((c) => c.name === name);
    if (!clip || feet.length < 2 || !hips) continue;
    const a = mixer.clipAction(clip);
    a.play();
    const N = 96, dt = clip.duration / N;
    const fp = new THREE.Vector3(), hp = new THREE.Vector3();
    const rel: number[][] = [[], []], hgt: number[][] = [[], []];
    for (let i = 0; i <= N; i++) {
      mixer.setTime(i * dt);
      root.updateMatrixWorld(true);
      hips.getWorldPosition(hp);
      feet.forEach((f, k) => { f.getWorldPosition(fp); rel[k].push(fp.z - hp.z); hgt[k].push(fp.y); }); // characters face +z
    }
    a.stop();
    const v: number[] = [];
    for (let k = 0; k < 2; k++) {
      const floor = Math.min(...hgt[k]);
      for (let i = 0; i < N; i++) {
        const lower = hgt[k][i] <= hgt[1 - k][i];
        if (lower && hgt[k][i] < floor + 0.03) v.push(-(rel[k][i + 1] - rel[k][i]) / dt); // backward = ground speed
      }
    }
    v.sort((x, y) => x - y);
    const med = v.length ? v[Math.floor(v.length / 2)] : 0;
    if (med > 0.3) g[name] = med;
  }
  mixer.stopAllAction();
  gaitCache.set(gltf, g);
  return g;
}

const UNGROUNDED = new Set(['jump', 'fall', 'enter_car', 'exit_car', 'push']);

/** A rigged, animated human (pedestrian or the hero). */
export class Person {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions = new Map<string, THREE.AnimationAction>();
  current: THREE.AnimationAction | null = null;
  currentName = '';
  yaw = 0;
  /** natural ground speed of the walk / run clips (m/s at timeScale 1) */
  gait: { walk: number; run: number };
  private feet: THREE.Object3D[] = [];
  ankle = 0.08;
  private baseY = 0;
  footOff = 0;
  private grounding = true;
  private shadow: THREE.Mesh;
  private tmp = new THREE.Vector3();

  constructor(gltf: GLTF, public type: string) {
    this.root = cloneSkinned(gltf.scene);
    this.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.frustumCulled = false; // skinned bounds don't follow the animation
        patchPersonMaterial(m.material as THREE.MeshStandardMaterial);
      }
      if (/(left|right)foot$/i.test(o.name)) this.feet.push(o);
    });
    // ankle height in the bind pose = where the foot bones sit when standing on the ground
    this.root.updateMatrixWorld(true);
    if (this.feet.length) this.ankle = Math.max(0.03, Math.min(...this.feet.map((f) => f.getWorldPosition(this.tmp).y)) - this.root.position.y);
    this.shadow = contactShadow();
    this.root.add(this.shadow);
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
    const g = gaitSpeeds(gltf);
    this.gait = { walk: g.walk ?? 1.25, run: g.run ?? 4.5 };
    this.gltf = gltf;
  }
  private gltf: GLTF;

  /** How far the clip has turned the body at time t (radians, relative to the idle stance). */
  heading(name: 'enter_car' | 'exit_car', t: number) {
    const tab = headingTables(this.gltf)[name];
    const clip = this.actions.get(name)?.getClip();
    if (!tab || !clip) return 0;
    const f = THREE.MathUtils.clamp(t / clip.duration, 0, 1) * HEADING_SAMPLES;
    const i = Math.min(HEADING_SAMPLES - 1, Math.floor(f));
    return THREE.MathUtils.lerp(tab[i], tab[i + 1], f - i);
  }
  clipDuration(name: Anim) { return this.actions.get(name)?.getClip().duration ?? 0; }

  has(name: string) { return this.actions.has(name); }

  play(name: Anim, opts: { fade?: number; loop?: boolean; speed?: number; restart?: boolean; from?: number } = {}) {
    const a = this.actions.get(name);
    if (!a) return 0;
    this.grounding = !UNGROUNDED.has(name);
    if (this.currentName === name && !opts.restart) { a.timeScale = opts.speed ?? 1; return a.getClip().duration; }
    a.reset();
    a.setLoop(opts.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = opts.loop === false;
    a.timeScale = opts.speed ?? 1;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (this.current && this.current !== a) a.crossFadeFrom(this.current, opts.fade ?? 0.25, false);
    a.play();
    if (opts.from) a.time = opts.from;
    this.current = a;
    this.currentName = name;
    return a.getClip().duration;
  }

  /** Playback rate that makes a gait clip cover exactly `speed` m/s (no foot sliding). */
  gaitRate(clip: 'walk' | 'run', speed: number) { return speed / this.gait[clip]; }

  /** Advance the animation; `ground` keeps the planted foot on the floor (fixes floating / sinking). */
  update(dt: number, ground = true) {
    this.mixer.update(dt);
    const want = ground && this.grounding && this.feet.length > 0;
    if (want) {
      this.root.position.y = this.baseY + this.footOff;
      this.root.updateMatrixWorld(true);
      let lo = Infinity;
      for (const f of this.feet) lo = Math.min(lo, f.getWorldPosition(this.tmp).y);
      const err = this.baseY + this.ankle - lo;
      this.footOff = THREE.MathUtils.clamp(this.footOff + err * Math.min(1, dt * 12), -0.35, 0.35);
    } else this.footOff *= Math.max(0, 1 - dt * 4);
    this.root.position.y = this.baseY + this.footOff;
    this.shadow.position.y = -this.footOff + 0.03;
  }

  place(x: number, y: number, z: number, yaw: number) {
    this.baseY = y;
    this.root.position.set(x, y + this.footOff, z);
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
      p.play('walk', { speed: p.gaitRate('walk', ped.speed) });
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
    p.vel.copy(away).multiplyScalar(3.4);
    p.p.play(p.p.has('run') ? 'run' : 'flee', { fade: 0.15, speed: p.p.has('run') ? p.p.gaitRate('run', 3.4) : 1.1 });
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
          if (p.t <= 0) { p.state = 'walk'; p.t = this.rng.range(6, 18); if (this.rng.chance(0.3)) p.dir = (p.dir * -1) as 1 | -1; p.p.play('walk', { fade: 0.4, speed: p.p.gaitRate('walk', p.speed) }); }
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
            p.p.play('walk', { fade: 0.4, speed: p.p.gaitRate('walk', p.speed) });
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
      if (d < 60 || (this.frame + p.id) % 3 === 0) p.p.update(d < 60 ? dt : dt * 3, d < 45);
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
