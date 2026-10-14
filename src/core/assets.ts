import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BASE = './assets/';

export const PBR_SETS = ['asphalt', 'concrete', 'brushed_metal', 'rusted_metal', 'glass_grime'] as const;
export const FACADE_IDS = ['apartment', 'office_glass', 'tenement', 'industrial', 'megablock', 'tower_lux'] as const;
export const SHOP_IDS = ['noodle', 'pharmacy', 'arcade', 'shutters', 'electronics', 'convenience', 'garage', 'bar'] as const;

export interface Assets {
  tex: Record<string, THREE.Texture>;
  signs: { id: string; tex: THREE.Texture; aspect: number }[];
  ads: { id: string; tex: THREE.Texture; aspect: number }[];
  kit: GLTF;
  car: GLTF | null;
  landmarks: Record<string, GLTF>;
  liveries: Record<string, THREE.Texture>;
}

export class Loader {
  private tl = new THREE.TextureLoader();
  private gl = new GLTFLoader();
  private total = 0;
  private done = 0;
  onProgress: (p: number, label: string) => void = () => {};

  constructor() {
    this.gl.setMeshoptDecoder(MeshoptDecoder);
  }

  private tick(label: string) {
    this.done++;
    this.onProgress(this.total ? this.done / this.total : 1, label);
  }

  tex(path: string, srgb = true): Promise<THREE.Texture> {
    this.total++;
    return new Promise((res) => {
      this.tl.load(BASE + path, (t) => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        this.tick(path);
        res(t);
      }, undefined, () => { console.warn('missing texture', path); this.tick(path); res(new THREE.Texture()); });
    });
  }

  gltf(path: string): Promise<GLTF | null> {
    this.total++;
    return new Promise((res) => {
      this.gl.load(BASE + path, (g) => { this.tick(path); res(g); }, undefined, async () => {
        // fallback for hosts that don't serve .glb: the same model as base64 inside <path>.json
        try {
          const r = await fetch(BASE + path + '.json');
          if (!r.ok) throw new Error(String(r.status));
          const b64: string = (await r.json()).glb;
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          this.gl.parse(bin.buffer, BASE + 'models/', (g) => { this.tick(path); res(g); }, (e) => { console.warn('model parse failed', path, e); this.tick(path); res(null); });
        } catch (e) { console.warn('missing model', path, e); this.tick(path); res(null); }
      });
    });
  }

  async json<T>(path: string): Promise<T> {
    const r = await fetch(BASE + path);
    return r.json();
  }

  async loadAll(): Promise<Assets> {
    const tex: Record<string, THREE.Texture> = {};
    const jobs: Promise<unknown>[] = [];
    for (const s of PBR_SETS) {
      jobs.push(this.tex(`tex/${s}_albedo.webp`).then((t) => (tex[`${s}_albedo`] = t)));
      jobs.push(this.tex(`tex/${s}_normal.webp`, false).then((t) => (tex[`${s}_normal`] = t)));
      jobs.push(this.tex(`tex/${s}_rough.webp`, false).then((t) => (tex[`${s}_rough`] = t)));
    }
    for (const f of FACADE_IDS) jobs.push(this.tex(`facade/${f}.webp`).then((t) => (tex[`facade_${f}`] = t)));
    jobs.push(this.tex('sky/night_pano.webp').then((t) => (tex.sky = t)));
    jobs.push(this.tex('sky/clouds.webp').then((t) => (tex.clouds = t)));
    // signs / ads are rendered from atlases (public/assets/atlas), loaded by the city
    const signs: Assets['signs'] = [];
    const ads: Assets['ads'] = [];
    const liveries: Record<string, THREE.Texture> = {};
    for (const l of ['liv_stripes', 'liv_tiger', 'liv_circuit', 'liv_kanji', 'liv_flames', 'liv_geo']) jobs.push(this.tex(`livery/${l}.png`).then((t) => (liveries[l] = t)));
    let kit: GLTF | null = null, car: GLTF | null = null;
    jobs.push(this.gltf('models/citykit.glb').then((g) => (kit = g)));
    jobs.push(this.gltf('models/hero_car.glb').then((g) => (car = g)));
    const landmarks: Record<string, GLTF> = {};
    for (const l of ['lm_pagoda', 'lm_watertower', 'lm_crane', 'lm_gate', 'lm_statue']) jobs.push(this.gltf(`models/${l}.glb`).then((g) => { if (g) landmarks[l] = g; }));
    await Promise.all(jobs);
    if (!kit) throw new Error('citykit.glb failed to load');
    return { tex, signs, ads, kit, car, landmarks, liveries };
  }
}

/** Find a named mesh (or merged group) in the kit, returning geometry+material pairs. */
export function kitParts(kit: GLTF, name: string): { geometry: THREE.BufferGeometry; material: THREE.Material }[] {
  const obj = kit.scene.getObjectByName(name);
  if (!obj) { console.warn('kit part missing', name); return []; }
  const out: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  obj.updateWorldMatrix(true, true);
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const g = m.geometry.clone();
      // de-quantize: normalized int attributes cannot hold metre-scale values after baking
      for (const name of Object.keys(g.attributes)) {
        const a = g.attributes[name] as THREE.BufferAttribute;
        if (a.array instanceof Float32Array && !(a as any).isInterleavedBufferAttribute) continue;
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k);
        g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
      }
      // All kit parts are authored at the origin in Blender, so the full world matrix is the
      // local frame. This also bakes the dequantization transform that meshopt/quantize puts on nodes.
      g.applyMatrix4(m.matrixWorld);
      out.push({ geometry: g, material: m.material as THREE.Material });
    }
  });
  return out;
}
