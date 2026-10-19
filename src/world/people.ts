import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { City } from './city';
import { CURB_H, type DistrictId } from './layout';
import { Rng } from './city';
import { poolUniforms, MAX_POOLS } from '../render/groundMaterial';

/** Animation names baked by blender/build_people.py */
export type Anim = 'walk' | 'run' | 'idle' | 'jump' | 'enter_car' | 'exit_car' | 'talk' | 'wave' | 'flee' | 'phone' | 'shrug' | 'push' | 'fall'
  | 'fight_idle' | 'punch' | 'jab' | 'kick' | 'get_up';

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
/**
 * The generated people have no face rig (no jaw bone, no blend shapes), so the jaw is made in the shader.
 * In the bind pose, head-skinned vertices are measured along the head's own axes (up from the Head bone
 * to head_end, forward toward headfront). Everything between the lip line and the bottom of the chin,
 * at the front of the face, hinges down around a point in front of the ears; the gap that opens between
 * the lips is darkened into an almond-shaped mouth. Lip heights were read off each model with the
 * calibration page (tests/face): they differ too much between generated faces to guess.
 */
const MOUTH_U: Record<string, number> = {
  hero: 0.088, ped_punk: 0.047, ped_nurse: 0.09, ped_elder: 0.088, ped_vendor: 0.09,
  ped_rider: 0.072, ped_student: 0.042, ped_suit: 0.078, ped_techwear: 0.072, ped_worker: 0.098,
};
interface FaceFrame { H: THREE.Vector3; U: THREE.Vector3; F: THREE.Vector3; L: THREE.Vector3; mouth: number; front: number; head: number; bones: THREE.Vector4 }
const faceFrames = new WeakMap<THREE.BufferGeometry, FaceFrame | null>();
function faceFrame(m: THREE.SkinnedMesh, type: string): FaceFrame | null {
  const geo = m.geometry;
  if (faceFrames.has(geo)) return faceFrames.get(geo)!;
  let out: FaceFrame | null = null;
  const bones = m.skeleton?.bones ?? [];
  const idx = (re: RegExp) => bones.findIndex((b) => re.test(b.name));
  const hi = idx(/^head$/i), ei = idx(/^head_?end$/i), fi = idx(/^head_?front$/i);
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const mouth = MOUTH_U[type];
  if (mouth !== undefined && hi >= 0 && ei >= 0 && fi >= 0 && pos && si && sw) {
    const bind = (i: number) => new THREE.Vector3().setFromMatrixPosition(m.skeleton.boneInverses[i].clone().invert());
    const H = bind(hi), U = bind(ei).sub(H).normalize();
    const F = bind(fi).sub(H); F.addScaledVector(U, -F.dot(U)).normalize();
    const L = new THREE.Vector3().crossVectors(U, F);
    // the lips' forward depth: the most forward head point at lip height on the midline
    const p = new THREE.Vector3();
    let front = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) { const b = si.getComponent(i, k); if (b === hi || b === ei || b === fi) w += sw.getComponent(i, k); }
      if (w < 0.5) continue;
      p.fromBufferAttribute(pos, i).sub(H);
      if (Math.abs(p.dot(U) - mouth) < 0.012 && Math.abs(p.dot(L)) < 0.02) front = Math.max(front, p.dot(F));
    }
    // some faces are skinned to the head's helper bones (head_end / headfront) rather than Head itself
    if (Number.isFinite(front)) out = { H, U, F, L, mouth, front, head: hi, bones: new THREE.Vector4(hi, ei, fi, -1) };
  }
  faceFrames.set(geo, out);
  return out;
}

function patchPersonMaterial(mat: THREE.MeshStandardMaterial, face: FaceFrame | null = null, mouth?: { value: number }) {
  if (mat.userData.personPatched) return;
  mat.userData.personPatched = true;
  // generated PBR maps can read as chrome under city reflections: keep skin and cloth dielectric
  mat.metalness = Math.min(mat.metalness, 0.15);
  mat.roughness = Math.max(mat.roughness, 0.55);
  mat.envMapIntensity = 0.9;
  const fu = {
    uFaceH: { value: face?.H ?? new THREE.Vector3() }, uFaceU: { value: face?.U ?? new THREE.Vector3(0, 1, 0) },
    uFaceF: { value: face?.F ?? new THREE.Vector3(0, 0, 1) }, uFaceL: { value: face?.L ?? new THREE.Vector3(1, 0, 0) },
    uFace: { value: new THREE.Vector4(face?.mouth ?? 0, face?.front ?? 0, 0, face ? face.head : -1) },
    uMouth: mouth ?? { value: 0 },
    uFaceBones: { value: face?.bones ?? new THREE.Vector4(-1, -1, -1, -1) },
    uFaceLine: { value: -99 }, // debug overlay (tests/face): a line at this height above the Head bone
  };
  mat.userData.faceUniforms = fu;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPoolPos = poolUniforms.uPoolPos;
    sh.uniforms.uPoolCol = poolUniforms.uPoolCol;
    Object.assign(sh.uniforms, fu);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform vec3 uFaceH; uniform vec3 uFaceU; uniform vec3 uFaceF; uniform vec3 uFaceL; uniform vec4 uFace; uniform vec4 uFaceBones; uniform float uMouth;
varying float vLip; varying float vLipX; varying float vFaceU; varying float vLipMask;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLip = 0.0; vLipX = 9.0; vLipMask = 0.0; vFaceU = dot(position - uFaceH, uFaceU);
        #ifdef USE_SKINNING
        if (uFace.w >= 0.0) {
          vec3 q = position - uFaceH;
          float fu = dot(q, uFaceU), ff = dot(q, uFaceF), fl = dot(q, uFaceL);
          float um = uFace.x, lipF = uFace.y;
          float hw = dot(skinWeight, vec4(equal(skinIndex, vec4(uFaceBones.x))) + vec4(equal(skinIndex, vec4(uFaceBones.y))) + vec4(equal(skinIndex, vec4(uFaceBones.z))));
          float below = smoothstep(um + 0.002, um - 0.007, fu);      // under the lip line
          float chin = smoothstep(um - 0.085, um - 0.06, fu);         // down to the bottom of the chin, not the collar
          float lat = 1.0 - smoothstep(0.045, 0.065, abs(fl));        // the jaw, not the cheeks behind it
          float front = smoothstep(lipF - 0.075, lipF - 0.035, ff);
          float jw = clamp(hw * 1.4 - 0.4, 0.0, 1.0) * below * chin * lat * front;
          // lip band (for the dark gap): only the step across the lip line, at the front of the face
          vLip = below; vLipX = fl; vLipMask = clamp(hw * 1.4 - 0.4, 0.0, 1.0) * front;
          // jaw: rotate about a hinge in front of the ear
          float a = uMouth * 0.14 * jw;
          vec2 d = vec2(fu - (um + 0.015), ff - (lipF - 0.1));
          vec2 r = vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a));
          transformed += uFaceU * (r.x - d.x) + uFaceF * (r.y - d.y);
        }
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uPoolPos[${MAX_POOLS}];\nuniform vec3 uPoolCol[${MAX_POOLS}];\nuniform float uMouth; uniform float uFaceLine;\nvarying float vLip; varying float vLipX; varying float vFaceU; varying float vLipMask;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          // the gap between the lips: the band stretched between the still upper lip and the dropped jaw,
          // narrowing toward the corners (almond shaped)
          float open = clamp(uMouth * 1.2, 0.0, 1.0);
          float across = (2.0 * vLip - 1.0) / max(open, 0.08);   // thin slit when barely open
          float x = vLipX / (0.019 + 0.006 * open);               // corners widen a little as it opens
          float lens = 1.0 - x * x - across * across;
          float dark = 0.85 * smoothstep(0.0, 0.08, open) * smoothstep(-0.1, 0.3, lens) * vLipMask;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.05, 0.05), dark);${(globalThis as { __faceDebug?: boolean }).__faceDebug ? '\n          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.0, 0.0), vLip * vLipMask * 0.6);\n          if (abs(vFaceU - uFaceLine) < 0.0012) diffuseColor.rgb = vec3(0.0, 1.0, 0.2);' : ''}
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          vec3 pAcc = vec3(0.0);
          for (int i = 0; i < ${MAX_POOLS}; i++) {
            vec4 lp = uPoolPos[i];
            vec3 lv = (viewMatrix * vec4(lp.xyz, 1.0)).xyz + vViewPosition;
            float d = length(lv);
            float att = clamp(1.0 - d / (lp.w * 1.15), 0.0, 1.0);
            att *= att;
            // very soft wrap: generated meshes have bumpy normals, and a hard N·L turned neon light
            // into coloured blotches across the clothes
            float wrap = clamp(dot(normal, lv / max(d, 1e-3)) * 0.35 + 0.65, 0.0, 1.0);
            pAcc += uPoolCol[i] * att * wrap;
          }
          // partly desaturated (light bounced off wet streets and walls reads as a tint, not paint) and
          // capped so a nearby bright source (car headlights) tints instead of bleaching the character
          float pl = dot(pAcc, vec3(0.299, 0.587, 0.114));
          pAcc = mix(vec3(pl), pAcc, 0.5);
          reflectedLight.directDiffuse += min(pAcc * 0.4, vec3(0.8)) * diffuseColor.rgb;
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

const _up = new THREE.Vector3(0, 1, 0), _lookAxis = new THREE.Vector3();
const _qW = new THREE.Quaternion(), _qP = new THREE.Quaternion(), _qParent = new THREE.Quaternion();

const UNGROUNDED = new Set(['jump', 'fall', 'enter_car', 'exit_car', 'push', 'get_up']);

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
  private neck?: THREE.Object3D;
  private head?: THREE.Object3D;
  /** world point to turn the head toward (eye level of whoever they are talking to), or null */
  look: THREE.Vector3 | null = null;
  /** 0..1 how animated the head is while speaking (nods, small sways) */
  speak = 0;
  private lookW = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private speakT = Math.random() * 10;
  /** loudness of their voice right now (0..1) drives the jaw; null = speaking without a voice track */
  mouthLevel: number | null = 0;
  private mouth = { value: 0 };
  /** recoil from a hit: 0..1, decays; `hitDir` +1 = knocked backwards, -1 = forwards */
  private hitK = 0;
  private hitDir = 1;
  private spineBone?: THREE.Object3D;
  /** take a hit: the upper body snaps back (or forward) and settles */
  hitReact(strength = 1, fromFront = true) { this.hitK = Math.min(1, this.hitK + strength); this.hitDir = fromFront ? 1 : -1; }
  private mouthT = Math.random() * 10;

  constructor(gltf: GLTF, public type: string) {
    this.root = cloneSkinned(gltf.scene);
    this.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.frustumCulled = false; // skinned bounds don't follow the animation
        // own material copy (same shader program) so each face opens its own mouth
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.userData = {};
        m.material = mat;
        patchPersonMaterial(mat, (m as THREE.SkinnedMesh).isSkinnedMesh ? faceFrame(m, type) : null, this.mouth);
      }
      if (/(left|right)foot$/i.test(o.name)) this.feet.push(o);
      if (/^neck$/i.test(o.name)) this.neck = o;
      if (/^head$/i.test(o.name)) this.head = o;
      if (/^spine01$/i.test(o.name)) this.spineBone = o;
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
    this.applyLook(dt);
  }

  /** Head / neck look-at layered on top of the animation (the mixer resets the bones every frame). */
  private applyLook(dt: number) {
    // jaw: the voice's loudness, or a syllable rhythm when there is no voice track
    let open = 0;
    if (this.mouthLevel === null) {
      this.mouthT += dt;
      const syl = Math.max(0, Math.sin(this.mouthT * 13.5) * 0.6 + Math.sin(this.mouthT * 5.1 + 1.3) * 0.4);
      open = this.speak > 0.3 ? syl * 0.8 : 0;
    } else open = this.mouthLevel;
    // opens fast, closes a little slower: reads as speech rather than flapping
    this.mouth.value += (open - this.mouth.value) * Math.min(1, dt * (open > this.mouth.value ? 28 : 16));
    if (this.hitK > 0.001) {
      // recoil: the chest and head snap away from the blow, then settle
      const by = this.root.rotation.y;
      const right = _lookAxis.set(-Math.cos(by), 0, Math.sin(by));
      const a = -this.hitK * this.hitDir * 0.5;
      this.root.updateMatrixWorld(true);
      for (const [bone, share] of [[this.spineBone, 0.55], [this.head, 0.45]] as const) {
        if (!bone || !bone.parent) continue;
        _qW.setFromAxisAngle(right, a * share);
        bone.parent.getWorldQuaternion(_qParent);
        bone.quaternion.premultiply(_qParent).premultiply(_qW).premultiply(_qParent.invert());
        bone.updateMatrixWorld(true);
      }
      this.hitK = Math.max(0, this.hitK - dt * 3.2);
    }
    const want = this.look && this.head ? 1 : 0;
    this.lookW += (want - this.lookW) * Math.min(1, dt * 4);
    if (this.lookW < 0.01 || !this.head) return;
    this.root.updateMatrixWorld(true);
    if (this.look) {
      const hp = this.head.getWorldPosition(this.tmp);
      const dx = this.look.x - hp.x, dy = this.look.y - hp.y, dz = this.look.z - hp.z;
      let yaw = Math.atan2(dx, dz) - this.root.rotation.y;
      yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      const pitch = Math.atan2(dy, Math.hypot(dx, dz));
      // ease toward the target; a person only turns their head so far before turning the body
      this.lookYaw += (THREE.MathUtils.clamp(yaw, -1.1, 1.1) - this.lookYaw) * Math.min(1, dt * 6);
      this.lookPitch += (THREE.MathUtils.clamp(pitch, -0.45, 0.4) - this.lookPitch) * Math.min(1, dt * 6);
    }
    this.speakT += dt;
    const k = this.speak;
    const nod = k * (Math.sin(this.speakT * 7.3) * 0.05 + Math.sin(this.speakT * 2.9) * 0.04);
    const sway = k * Math.sin(this.speakT * 1.7) * 0.06;
    const yaw = this.lookYaw * this.lookW + sway, pitch = this.lookPitch * this.lookW + nod;
    const by = this.root.rotation.y;
    const right = _lookAxis.set(-Math.cos(by), 0, Math.sin(by)); // forward x up: positive angle looks up
    // neck takes 40 % of the turn, the head the rest
    for (const [bone, share] of [[this.neck, 0.4], [this.head, this.neck ? 0.6 : 1]] as const) {
      if (!bone || !bone.parent) continue;
      _qW.setFromAxisAngle(_up, yaw * share).multiply(_qP.setFromAxisAngle(right, pitch * share));
      bone.parent.getWorldQuaternion(_qParent);
      // local' = parent^-1 * delta(world) * parent * local
      bone.quaternion.premultiply(_qParent).premultiply(_qW).premultiply(_qParent.invert());
      bone.updateMatrixWorld(true);
    }
  }

  place(x: number, y: number, z: number, yaw: number) {
    this.baseY = y;
    this.root.position.set(x, y + this.footOff, z);
    this.yaw = yaw;
    this.root.rotation.y = yaw;
  }
}

export type PedState = 'walk' | 'idle' | 'flee' | 'down' | 'talk' | 'wave' | 'phone' | 'fight' | 'getup';

export interface Ped {
  p: Person; type: PedType;
  rect: number; s: number; dir: 1 | -1; speed: number;
  state: PedState; t: number; pos: THREE.Vector3; vel: THREE.Vector3; id: number;
  /** regulars: their spot, the way they face, and who they are */
  home?: THREE.Vector3; homeYaw?: number; key?: string;
  /** what they were doing before someone stopped them to talk */
  prevState?: PedState;
  /** sideways step off the loop line (m, + = walker's right): keeping to their side and going around people */
  off?: number;
  /** fighting (game/fight.ts): health, knocked out, next swing, a swing in progress */
  hp?: number; ko?: boolean; swingCd?: number; swing?: { t: number; hit: number; done: boolean; kind: 'punch' | 'jab' };
}
const BODY_R = 0.32; // how close two people's centres may get before they push apart (m)

/** Sidewalk crowds: pedestrians loop around blocks near the player, stop, chat on phones, flee from cars. */
export class Crowd {
  group = new THREE.Group();
  peds: Ped[] = [];
  private rng = new Rng(4242);
  private pool = new Map<PedType, Person[]>();
  private nextId = 1;
  onHit: (pos: THREE.Vector3, speed: number) => void = () => {};
  onScream: (pos: THREE.Vector3) => void = () => {};
  /** someone started running from a car (for street reactions) */
  onFlee: (ped: Ped, from: THREE.Vector3) => void = () => {};

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

  /** A regular: stands at their spot (and walks back to it), never wanders off. */
  addFixed(type: PedType, pos: THREE.Vector3, yaw: number, key: string): Ped | null {
    if (!this.assets[type]) return null;
    const p = this.take(type);
    const ped: Ped = { p, type, rect: 0, s: 0, dir: 1, speed: 1.2, state: 'idle', t: 1e9, pos: pos.clone(), vel: new THREE.Vector3(), id: this.nextId++, home: pos.clone(), homeYaw: yaw, key };
    p.yaw = yaw;
    p.play('idle', { fade: 0 });
    p.mixer.setTime(this.rng.next() * 3);
    this.peds.push(ped);
    return ped;
  }
  byKey(key: string) { return this.peds.find((p) => p.key === key) ?? null; }

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
    if (ped.state !== 'talk') ped.prevState = ped.state;
    ped.state = 'talk';
    ped.t = dur;
    ped.p.yaw = Math.atan2(facing.x - ped.pos.x, facing.z - ped.pos.z);
    ped.p.play('talk', { fade: 0.3 });
  }

  /** Everyone nearby panics (carjack, crash, police). */
  panic(at: THREE.Vector3, radius: number) {
    for (const p of this.peds) if (p.state !== 'down' && p.pos.distanceTo(at) < radius) this.flee(p, at);
  }
  flee(p: Ped, from: THREE.Vector3) {
    if (p.home) return; // regulars hold their ground
    if (p.state === 'flee') { p.t = Math.max(p.t, 3); return; }
    p.state = 'flee';
    p.t = this.rng.range(4, 7);
    const away = p.pos.clone().sub(from).setY(0);
    if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    away.normalize();
    p.vel.copy(away).multiplyScalar(3.4);
    this.onFlee(p, from);
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
          const { pace, side } = this.steer(p, player);
          const off0 = p.off ?? 0;
          p.off = off0 + THREE.MathUtils.clamp(side - off0, -1.4 * dt, 1.4 * dt);
          p.s += p.dir * p.speed * pace * dt;
          const { dx, dz } = this.perim(p.rect, p.s, p.pos);
          // the walker's right: keep to it, and step around whoever is in the way
          p.pos.x += -dz * p.dir * p.off; p.pos.z += dx * p.dir * p.off;
          const sideV = (p.off - off0) / Math.max(dt, 1e-3);
          const want = Math.atan2(dx * p.dir * p.speed * pace - dz * p.dir * sideV, dz * p.dir * p.speed * pace + dx * p.dir * sideV);
          if (pace > 0.15 || Math.abs(sideV) > 0.2) p.p.yaw = lerpAngle(p.p.yaw, want, Math.min(1, dt * 6));
          const gait = pace < 0.15 ? 'idle' : 'walk';
          if (p.p.currentName !== gait) p.p.play(gait, { fade: 0.3, speed: gait === 'walk' ? p.p.gaitRate('walk', p.speed) : 1 });
          if (p.t <= 0) {
            const r = this.rng.next();
            // stop for a moment: stand, or check the phone (waving at nobody looked odd)
            p.state = r < 0.55 ? 'idle' : 'phone';
            p.t = this.rng.range(3, 8);
            p.p.play(p.state, { fade: 0.4 });
          }
          break;
        }
        case 'idle': case 'phone': case 'wave': case 'talk':
          if (p.home) { this.atHome(p, dt); break; }
          if (p.t <= 0) { p.state = 'walk'; p.t = this.rng.range(6, 18); if (this.rng.chance(0.3)) p.dir = (p.dir * -1) as 1 | -1; p.p.play('walk', { fade: 0.4, speed: p.p.gaitRate('walk', p.speed) }); }
          break;
        case 'flee': {
          p.pos.addScaledVector(p.vel, dt);
          this.keepOutOfBuildings(p);
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
          this.keepOutOfBuildings(p);
          p.vel.multiplyScalar(Math.max(0, 1 - dt * 3));
          if (p.home && p.t <= 0) { p.state = 'idle'; p.t = 1e9; p.p.play('idle', { fade: 0.6 }); }
          break;
      }
      const ground = this.onSidewalk(p.pos) ? CURB_H : 0;
      p.p.place(p.pos.x, ground, p.pos.z, p.p.yaw);
      // animation LOD: far crowds update at a lower rate
      const d = p.pos.distanceTo(player);
      // feet stay on the ground at any distance you can see them (far ones used to hover)
      if (d < 60 || (this.frame + p.id) % 3 === 0) p.p.update(d < 60 ? dt : dt * 3, d < 130);
    }
    this.separate();
    this.frame++;
  }
  private frame = 0;

  /**
   * Look a couple of metres ahead along the loop: slow down behind someone going the same way, step to
   * the side around anyone coming the other way, standing still, or the courier. Returns the sideways
   * offset to aim for and a speed factor.
   */
  private steer(p: Ped, player: THREE.Vector3) {
    const tmp = this.perimDir(p.rect, p.s);
    const fx = tmp.dx * p.dir, fz = tmp.dz * p.dir; // forward
    const rx = -fz, rz = fx; // right
    let side = 0.45, pace = 1; // keep right so people going opposite ways pass ~1 m apart
    const look = (ox: number, oz: number, sameWay: boolean, still: boolean) => {
      const relx = ox - p.pos.x, relz = oz - p.pos.z;
      if (Math.abs(relx) > 3 || Math.abs(relz) > 3) return;
      const ahead = relx * fx + relz * fz, lat = relx * rx + relz * rz;
      if (ahead <= 0 || ahead > 2.6 || Math.abs(lat) > 0.85) return;
      if (sameWay && !still) { pace = Math.min(pace, THREE.MathUtils.clamp((ahead - 0.8) / 0.9, 0, 1)); return; }
      // pass on the side with more room: away from them, towards our own right if dead ahead
      const dirSide = lat > 0.05 ? -1 : 1;
      side = THREE.MathUtils.clamp((p.off ?? 0) + dirSide * (0.9 - Math.abs(lat)) * (1 - ahead / 3.2) * 1.6, -1.1, 1.1);
      if (ahead < 0.75) pace = Math.min(pace, 0.25);
    };
    for (const o of this.peds) {
      if (o === p || o.state === 'down') continue;
      const walking = o.state === 'walk' && o.rect === p.rect;
      look(o.pos.x, o.pos.z, walking && o.dir === p.dir, !walking);
    }
    look(player.x, player.z, false, true);
    return { pace, side };
  }
  private perimDir(ri: number, s: number) { return this.perim(ri, s, this.scratch); }
  private scratch = new THREE.Vector3();

  /** Nobody stands inside anybody else: overlapping pairs are pushed apart (walkers via their side step). */
  private separate() {
    const ps = this.peds;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.state === 'down') continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (b.state === 'down') continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        if (Math.abs(dx) > BODY_R * 2 || Math.abs(dz) > BODY_R * 2) continue;
        const d = Math.hypot(dx, dz);
        if (d >= BODY_R * 2) continue;
        const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0, push = (BODY_R * 2 - d) / 2;
        this.nudge(a, -nx * push, -nz * push);
        this.nudge(b, nx * push, nz * push);
      }
    }
  }
  private nudge(p: Ped, x: number, z: number) {
    p.pos.x += x; p.pos.z += z;
    if (p.state === 'walk') {
      // fold the push into the side step so the next frame keeps it
      const t = this.perimDir(p.rect, p.s);
      p.off = THREE.MathUtils.clamp((p.off ?? 0) + (-t.dz * p.dir) * x + (t.dx * p.dir) * z, -1.2, 1.2);
    }
    p.p.place(p.pos.x, p.p.root.position.y, p.pos.z, p.p.yaw);
  }

  /**
   * The courier can't walk through people either: anyone overlapping gets nudged aside and the courier
   * is held back by the rest. Returns how far to move the courier (zero when clear).
   */
  shoveFrom(pos: THREE.Vector3, r = 0.34): THREE.Vector3 {
    const out = new THREE.Vector3();
    for (const p of this.peds) {
      if (p.state === 'down') continue;
      const dx = p.pos.x - pos.x, dz = p.pos.z - pos.z;
      if (Math.abs(dx) > 1 || Math.abs(dz) > 1) continue;
      const d = Math.hypot(dx, dz), min = r + BODY_R;
      if (d >= min) continue;
      const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0, gap = min - d;
      // a regular or someone in a conversation holds their spot; others give way half the distance
      const give = p.home || p.state === 'talk' ? 0 : 0.5;
      this.nudge(p, nx * gap * give, nz * gap * give);
      out.x -= nx * gap * (1 - give); out.z -= nz * gap * (1 - give);
    }
    return out;
  }

  /** Regulars: walk back to their spot if knocked away, then stand facing the street. */
  private atHome(p: Ped, dt: number) {
    if (p.state === 'talk' && p.t > 0) return; // in a conversation: it controls facing
    if (p.state === 'talk') { p.state = 'idle'; p.t = 1e9; }
    const to = p.home!.clone().sub(p.pos).setY(0);
    const d = to.length();
    if (d > 0.4) {
      const step = Math.min(d, 1.2 * dt);
      p.pos.addScaledVector(to.normalize(), step);
      p.p.yaw = lerpAngle(p.p.yaw, Math.atan2(to.x, to.z), Math.min(1, dt * 6));
      if (p.p.currentName !== 'walk') p.p.play('walk', { fade: 0.3, speed: p.p.gaitRate('walk', 1.2) });
    } else {
      p.p.yaw = lerpAngle(p.p.yaw, p.homeYaw!, Math.min(1, dt * 3));
      if (p.p.currentName === 'walk' || p.p.currentName === 'talk') p.p.play('idle', { fade: 0.5 });
    }
  }

  /**
   * Buildings fill each block inside its sidewalk loop. Someone running off in a straight line (fleeing,
   * knocked down) is stopped at the facade and turned to run along it instead of into the wall.
   */
  private keepOutOfBuildings(p: Ped) {
    const M = 0.9; // the loop is 1.4 m in from the curb; facades start ~1.6 m further in
    for (const r of this.city.walkRects) {
      const dx = p.pos.x - r.x, dz = p.pos.z - r.z;
      const ix = r.hw - M - Math.abs(dx), iz = r.hd - M - Math.abs(dz);
      if (ix <= 0 || iz <= 0) continue;
      if (ix < iz) { p.pos.x = r.x + Math.sign(dx || 1) * (r.hw - M); if (p.vel.x * Math.sign(dx || 1) < 0) p.vel.x = 0; }
      else { p.pos.z = r.z + Math.sign(dz || 1) * (r.hd - M); if (p.vel.z * Math.sign(dz || 1) < 0) p.vel.z = 0; }
      // keep running along the wall at the same pace
      const sp = Math.hypot(p.vel.x, p.vel.z);
      if (p.state === 'flee' && sp < 1) { if (ix < iz) p.vel.z = (Math.sign(p.vel.z) || 1) * 3.4; else p.vel.x = (Math.sign(p.vel.x) || 1) * 3.4; }
      return;
    }
  }

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

  /** A person standing at `pos` facing `yaw` (tests and scripted scenes), on the nearest sidewalk loop. */
  spawnAt(type: PedType, pos: THREE.Vector3, yaw: number): Ped | null {
    if (!this.assets[type]) return null;
    const p = this.take(type);
    let best = 0, bd = Infinity;
    this.city.walkRects.forEach((r, i) => { const d = Math.hypot(r.x - pos.x, r.z - pos.z); if (d < bd) { bd = d; best = i; } });
    const ped: Ped = { p, type, rect: best, s: this.arcOf(best, pos), dir: 1, speed: 1.3, state: 'idle', t: 30, pos: pos.clone(), vel: new THREE.Vector3(), id: this.nextId++ };
    p.yaw = yaw;
    p.play('idle', { fade: 0 });
    this.peds.push(ped);
    return ped;
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
