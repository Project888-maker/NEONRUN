import * as THREE from 'three';
import type { Assets } from '../core/assets';
import { kitParts } from '../core/assets';
import type { Physics } from '../core/physics';
import { RAPIER, GROUP_GATE, groups, GROUP_CAR } from '../core/physics';
import { GRID, PITCH, HALF, ROAD_W, SIDEWALK, CURB_H, ALLEY_W, RAIL_Z, DISTRICTS, DistrictId, lineCoord, blockCenter, districtOfBlock, districtGates, DISTRICT_ORDER, plinthRects } from './layout';
import { createBuildingMaterial, FACADES, unitBox } from '../render/buildingMaterial';
import { createGroundMaterial } from '../render/groundMaterial';
import { createAtlasMaterial, createConeMaterial, createTrafficLampMaterial } from '../render/specialMaterials';
import type { PlanarReflector } from '../render/reflector';
import { LAYER_NO_REFLECT } from '../render/reflector';

export interface LightSrc { pos: THREE.Vector3; color: THREE.Color; radius: number; kind: 'lamp' | 'sign' | 'other' }
export interface Spot { x: number; z: number; district: DistrictId; nx: number; nz: number }
export interface SoundSpot { pos: THREE.Vector3; type: 'neon' | 'steam' | 'crowd' }

export class Rng {
  constructor(private s: number) {}
  next() { this.s = (this.s * 1664525 + 1013904223) >>> 0; return this.s / 4294967296; }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(a: readonly T[]): T { return a[Math.floor(this.next() * a.length) % a.length]; }
  chance(p: number) { return this.next() < p; }
}

const CHUNK_BLOCKS = 2;
const NCH = GRID / CHUNK_BLOCKS;
export const chunkOf = (x: number, z: number) => {
  const cx = Math.min(NCH - 1, Math.max(0, Math.floor((x + HALF) / (PITCH * CHUNK_BLOCKS))));
  const cz = Math.min(NCH - 1, Math.max(0, Math.floor((z + HALF) / (PITCH * CHUNK_BLOCKS))));
  return cz * NCH + cx;
};

interface BatchEntry { geo: THREE.BufferGeometry; mat: THREE.Material; chunk: number; m: THREE.Matrix4[]; attrs: Record<string, { size: number; data: number[] }>; layer?: number; small: boolean }

export const SMALL_PROPS = new Set(['hydrant', 'bin', 'barrier', 'vent', 'ac_unit', 'water_tank', 'antenna', 'bollard', 'bench', 'sign_bracket', 'awning', 'pipes']);

/** Collects instance transforms per (geometry, material, chunk) and builds InstancedMeshes. */
class Batcher {
  map = new Map<string, BatchEntry>();
  add(key: string, chunk: number, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, attrs?: Record<string, number[]>, layer?: number) {
    const k = `${key}|${chunk}`;
    let e = this.map.get(k);
    if (!e) { e = { geo, mat, chunk, m: [], attrs: {}, layer, small: key.startsWith('kit:') && SMALL_PROPS.has(key.split(':')[1]) }; this.map.set(k, e); }
    e.m.push(m.clone());
    if (attrs) for (const [n, v] of Object.entries(attrs)) {
      (e.attrs[n] ??= { size: v.length, data: [] }).data.push(...v);
    }
  }
  build(chunks: THREE.Group[], small: THREE.Group[]) {
    for (const e of this.map.values()) {
      const im = new THREE.InstancedMesh(e.geo, e.mat, e.m.length);
      e.m.forEach((m, i) => im.setMatrixAt(i, m));
      // geometry is shared across chunks; per-instance attributes need a per-mesh geometry clone
      if (Object.keys(e.attrs).length) {
        const g = e.geo.clone();
        for (const [n, a] of Object.entries(e.attrs)) g.setAttribute(n, new THREE.InstancedBufferAttribute(new Float32Array(a.data), a.size));
        im.geometry = g;
      }
      im.computeBoundingSphere();
      im.instanceMatrix.needsUpdate = true;
      if (e.layer !== undefined) im.layers.set(e.layer);
      im.matrixAutoUpdate = false;
      im.updateMatrix();
      if (e.small) { im.layers.set(LAYER_NO_REFLECT); small[e.chunk].add(im); } else chunks[e.chunk].add(im);
    }
    this.map.clear();
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const mtx = (x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1) =>
  tmpM.compose(tmpP.set(x, y, z), tmpQ.setFromAxisAngle(UP, rotY), tmpS.set(sx, sy, sz));

export interface CityOptions { reflector?: PlanarReflector; envMap: THREE.Texture | null }

export class City {
  root = new THREE.Group();
  chunks: THREE.Group[] = [];
  smallChunks: THREE.Group[] = [];
  chunkCenters: THREE.Vector3[] = [];
  far = new THREE.Group();
  lights: LightSrc[] = [];
  spots: Spot[] = [];
  /** sidewalk loops for pedestrians: rectangle centred at (x,z) with half sizes, walked 1.4 m in from the kerb */
  walkRects: { x: number; z: number; hw: number; hd: number; district: DistrictId }[] = [];
  sounds: SoundSpot[] = [];
  steam: THREE.Vector3[] = [];
  videoScreens: { mesh: THREE.Mesh; clip: string }[] = [];
  gates: Record<string, { meshes: THREE.Object3D[]; colliders: RAPIER.Collider[] }> = {};
  landmarkSpots: { id: string; pos: THREE.Vector3; rot: number; scale: number; district: DistrictId }[] = [];
  groundMats: THREE.Material[] = [];
  buildingMats: THREE.MeshStandardMaterial[] = [];
  private b = new Batcher();
  private rng = new Rng(1337);
  private signInfo: Record<string, { aspect: number; color: number[]; uv: number[] }> = {};
  private adInfo: Record<string, { aspect: number; uv: number[] }> = {};
  private shopInfo: Record<string, number[]> = {};
  private signIds: Record<string, string[]> = {};
  private mats: Record<string, THREE.Material> = {};
  private geo: Record<string, THREE.BufferGeometry> = {};
  private kit: Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }[]> = {};

  constructor(private a: Assets, private phys: Physics, private opts: CityOptions, atlases: { signs: any; ads: any; shops: any; signTex: THREE.Texture; adTex: THREE.Texture; shopTex: THREE.Texture }) {
    for (let i = 0; i < NCH * NCH; i++) {
      const g = new THREE.Group();
      g.name = `chunk${i}`;
      this.chunks.push(g);
      this.root.add(g);
      const sg = new THREE.Group();
      g.add(sg);
      this.smallChunks.push(sg);
      const cx = -HALF + (i % NCH + 0.5) * PITCH * CHUNK_BLOCKS, cz = -HALF + (Math.floor(i / NCH) + 0.5) * PITCH * CHUNK_BLOCKS;
      this.chunkCenters.push(new THREE.Vector3(cx, 0, cz));
    }
    this.root.add(this.far);
    this.signInfo = atlases.signs;
    this.adInfo = atlases.ads;
    this.shopInfo = atlases.shops;
    const ids = Object.keys(this.signInfo);
    this.signIds.latin = ids.filter((i) => !i.startsWith('cjk_'));
    this.signIds.cjk = ids.filter((i) => i.startsWith('cjk_'));
    this.signIds.vertical = ids.filter((i) => this.signInfo[i].aspect < 0.7);
    this.signIds.horizontal = ids.filter((i) => this.signInfo[i].aspect >= 0.7);

    this.mats.sign = createAtlasMaterial(atlases.signTex, { additive: true, intensity: 3.2, flicker: 1, doubleSide: true });
    this.mats.ad = createAtlasMaterial(atlases.adTex, { additive: false, intensity: 1.35, flicker: 0 });
    this.mats.shop = createAtlasMaterial(atlases.shopTex, { additive: false, intensity: 1.05, flicker: 0 });
    this.mats.cone = createConeMaterial(0.22);
    this.mats.tlamp = createTrafficLampMaterial();
    this.geo.quad = new THREE.PlaneGeometry(1, 1);
    const cone = new THREE.ConeGeometry(1, 1, 20, 1, true);
    cone.translate(0, -0.5, 0); // apex at origin, opening downward
    this.geo.cone = cone;
    this.geo.box = unitBox();

    for (const name of ['lamp_post', 'hydrant', 'bin', 'barrier', 'holo_barrier', 'vent', 'ac_unit', 'water_tank', 'antenna', 'bollard', 'bench', 'traffic_light', 'tl_red', 'tl_amber', 'tl_green', 'container', 'rail_portal', 'rail_track', 'billboard_frame', 'sign_bracket', 'awning', 'pipes']) {
      this.kit[name] = kitParts(a.kit, name).map((p) => ({ geometry: p.geometry, material: this.fixMaterial(p.material) }));
    }
    for (const f of Object.keys(FACADES)) {
      const m = createBuildingMaterial(a.tex[`facade_${f}`], FACADES[f], opts.envMap);
      this.mats[`fac_${f}`] = m;
      this.buildingMats.push(m);
    }
    const contMat = new THREE.MeshStandardMaterial({ map: a.tex.rusted_metal_albedo, normalMap: a.tex.rusted_metal_normal, roughnessMap: a.tex.rusted_metal_rough, metalness: 0.4 });
    this.mats.container = contMat;
  }

  private fixMaterial(m: THREE.Material) {
    const s = m as THREE.MeshStandardMaterial;
    if (m.name.startsWith('emit_')) {
      s.emissiveIntensity = 7;
      s.toneMapped = true;
    } else if (m.name === 'glass') {
      s.transparent = true; s.opacity = 0.55; s.roughness = 0.05; s.metalness = 0.2;
    } else if (m.name === 'concrete') {
      s.map = this.a.tex.concrete_albedo; s.normalMap = this.a.tex.concrete_normal; s.roughnessMap = this.a.tex.concrete_rough; s.color.set(0xffffff);
    } else if (m.name.startsWith('metal')) {
      s.roughnessMap = this.a.tex.brushed_metal_rough;
    }
    if (this.opts.envMap && !m.name.startsWith('emit_')) { s.envMap = this.opts.envMap; s.envMapIntensity = 0.8; }
    s.needsUpdate = true;
    return m;
  }

  private prop(name: string, x: number, y: number, z: number, rot = 0, scale = 1, extraAttrs?: Record<string, number[]>) {
    const parts = this.kit[name];
    const c = chunkOf(x, z);
    const m = mtx(x, y, z, rot, scale, scale, scale);
    parts.forEach((p, i) => this.b.add(`kit:${name}:${i}`, c, p.geometry, p.material, m, extraAttrs));
  }

  build() {
    this.buildGround();
    this.buildBlocks();
    this.buildStreetFurniture();
    this.buildRail();
    this.buildBackdrop();
    this.buildGates();
    this.b.build(this.chunks, this.smallChunks);
    // boundary walls
    for (const [x, z, hx, hz] of [[0, -HALF - 22, HALF + 40, 2], [0, HALF + 22, HALF + 40, 2], [-HALF - 22, 0, 2, HALF + 40], [HALF + 22, 0, 2, HALF + 40]]) {
      this.phys.box(x, 10, z, hx, 10, hz);
    }
    return this;
  }

  // ------------------------------------------------------------- ground
  private buildGround() {
    const r = this.opts.reflector;
    const t = this.a.tex;
    const roadMat = createGroundMaterial({ albedo: t.asphalt_albedo, normal: t.asphalt_normal, rough: t.asphalt_rough, tile: 7, markings: true, reflector: r, reflectStrength: 1, puddles: 1 });
    const walkMat = createGroundMaterial({ albedo: t.concrete_albedo, normal: t.concrete_normal, rough: t.concrete_rough, tile: 3.2, markings: false, reflector: r, reflectStrength: 0.75, puddles: 0.8, color: new THREE.Color(0.55, 0.55, 0.58) });
    this.groundMats.push(roadMat, walkMat);
    const size = HALF * 2 + 60;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2), roadMat);
    road.layers.set(LAYER_NO_REFLECT);
    road.receiveShadow = true;
    this.root.add(road);
    // sidewalk plinths
    for (const { x, z, hw, hd, district } of plinthRects()) {
      this.walkRects.push({ x, z, hw: hw - 1.4, hd: hd - 1.4, district });
      this.b.add('plinth', chunkOf(x, z), this.geo.box, walkMat, mtx(x, 0, z, 0, hw * 2, CURB_H, hd * 2), undefined, LAYER_NO_REFLECT);
      this.phys.box(x, CURB_H / 2, z, hw, CURB_H / 2, hd, 0, 0.9);
    }
    // dark water beyond the docks edge
    const water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2), createGroundMaterial({ albedo: t.asphalt_albedo, normal: t.glass_grime_normal, rough: t.glass_grime_rough, tile: 30, markings: false, reflector: r, reflectStrength: 1.4, puddles: 0, color: new THREE.Color(0.02, 0.03, 0.04) }));
    water.position.set(HALF + 40 + 700, -1.5, HALF / 2);
    water.layers.set(LAYER_NO_REFLECT);
    this.far.add(water);
  }

  // ------------------------------------------------------------- buildings
  private buildBlocks() {
    const rng = this.rng;
    const inner = PITCH - ROAD_W - SIDEWALK * 2; // 76
    // choose plaza block in neon (statue) and a landmark tower
    const plaza = { i: 5, j: 6 };
    for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
      const d = districtOfBlock(i, j);
      const cx = blockCenter(i), cz = blockCenter(j);
      if (i === plaza.i && j === plaza.j) {
        this.landmarkSpots.push({ id: 'lm_statue', pos: new THREE.Vector3(cx, CURB_H, cz), rot: Math.PI * 0.25, scale: 14, district: d });
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          this.prop('bench', cx + Math.cos(a) * 16, CURB_H, cz + Math.sin(a) * 16, -a + Math.PI / 2);
          this.prop('bollard', cx + Math.cos(a + 0.2) * 22, CURB_H, cz + Math.sin(a + 0.2) * 22);
        }
        this.addAdTower(cx + 30, cz - 30, 0);
        continue;
      }
      if (d === 'docks') { this.buildDocksBlock(i, j, cx, cz, inner); continue; }
      const areas: { x0: number; x1: number; z0: number; z1: number }[] = d === 'backstreets'
        ? [{ x0: cx - inner / 2, x1: cx + inner / 2, z0: cz - inner / 2, z1: cz - ALLEY_W / 2 - 1 }, { x0: cx - inner / 2, x1: cx + inner / 2, z0: cz + ALLEY_W / 2 + 1, z1: cz + inner / 2 }]
        : [{ x0: cx - inner / 2, x1: cx + inner / 2, z0: cz - inner / 2, z1: cz + inner / 2 }];
      for (const ar of areas) {
        const nx = d === 'downtown' ? rng.int(1, 3) : rng.int(2, 4);
        const nz = d === 'backstreets' ? 1 : d === 'downtown' ? rng.int(1, 3) : rng.int(2, 3);
        const xs = this.cuts(ar.x0, ar.x1, nx), zs = this.cuts(ar.z0, ar.z1, nz);
        for (let a = 0; a < nx; a++) for (let c = 0; c < nz; c++) {
          const gap = d === 'downtown' ? rng.range(2, 6) : rng.range(0.3, 2.2);
          const lx0 = xs[a] + gap / 2, lx1 = xs[a + 1] - gap / 2, lz0 = zs[c] + gap / 2, lz1 = zs[c + 1] - gap / 2;
          if (lx1 - lx0 < 8 || lz1 - lz0 < 8) continue;
          const interior = a > 0 && a < nx - 1 && c > 0 && c < nz - 1;
          this.addBuilding(d, (lx0 + lx1) / 2, (lz0 + lz1) / 2, lx1 - lx0, lz1 - lz0, { n: c === 0, s: c === nz - 1, w: a === 0, e: a === nx - 1 }, interior, ar.z1 - ar.z0 < inner / 2 + 1 ? (ar.z0 > cz ? 'alleyN' : 'alleyS') : null);
        }
      }
    }
  }

  private cuts(a: number, b: number, n: number) {
    const out = [a];
    for (let k = 1; k < n; k++) out.push(a + ((b - a) * k) / n + this.rng.range(-0.12, 0.12) * (b - a) / n);
    out.push(b);
    return out;
  }

  private addBuilding(d: DistrictId, x: number, z: number, w: number, dz: number, street: { n: boolean; s: boolean; w: boolean; e: boolean }, interior: boolean, alley: string | null) {
    const rng = this.rng;
    const info = DISTRICTS[d];
    let h = rng.range(info.hMin, info.hMax);
    if (d === 'downtown') {
      const centerBias = 1 - Math.min(1, Math.hypot(x - HALF / 2, z + HALF / 2) / (HALF * 0.8));
      h = info.hMin + (info.hMax - info.hMin) * Math.pow(rng.next(), 1.3) * (0.4 + 0.6 * centerBias);
    }
    if (rng.chance(0.08) && d !== 'backstreets') h *= 1.6;
    if (interior) h *= 0.8;
    const fac = rng.pick(info.facades);
    const mat = this.mats[`fac_${fac}`];
    const chunk = chunkOf(x, z);
    const rand = () => [rng.next(), rng.next(), rng.next(), rng.next()];
    // tiers
    let tw = w, td = dz, y = 0;
    const tiers = h > 70 && rng.chance(0.65) ? rng.int(2, 3) : 1;
    for (let t = 0; t < tiers; t++) {
      const th = tiers === 1 ? h : t === 0 ? h * rng.range(0.45, 0.65) : (h - y) / (tiers - t) * (t === tiers - 1 ? 1 : rng.range(0.8, 1));
      const thh = t === tiers - 1 ? h - y : th;
      const ox = t === 0 ? 0 : rng.range(-0.1, 0.1) * w;
      const oz = t === 0 ? 0 : rng.range(-0.1, 0.1) * dz;
      this.b.add(`bld:${fac}`, chunk, this.geo.box, mat, mtx(x + ox, y + CURB_H, z + oz, 0, tw, thh, td), { aRand: rand() });
      y += thh;
      tw *= rng.range(0.68, 0.85);
      td *= rng.range(0.68, 0.85);
    }
    this.phys.box(x, h / 2, z, w / 2, h / 2, dz / 2, 0, 0.15);
    const topW = tw / (tiers > 1 ? 0.76 : 1), topD = td / (tiers > 1 ? 0.76 : 1);
    // rooftop clutter
    const roofY = h + CURB_H;
    const nAc = rng.int(0, 3);
    for (let k = 0; k < nAc; k++) this.prop('ac_unit', x + rng.range(-0.35, 0.35) * topW, roofY, z + rng.range(-0.35, 0.35) * topD, rng.pick([0, Math.PI / 2]), rng.range(1.2, 2));
    if ((d === 'backstreets' || d === 'neon') && rng.chance(0.18) && h < 60) {
      if (rng.chance(0.3)) this.landmarkSpots.push({ id: 'lm_watertower', pos: new THREE.Vector3(x, roofY, z), rot: rng.range(0, 6.28), scale: 9, district: d });
      else this.prop('water_tank', x + rng.range(-0.2, 0.2) * topW, roofY, z + rng.range(-0.2, 0.2) * topD, 0, rng.range(0.9, 1.3));
    }
    if (h > 50 && rng.chance(0.5)) {
      const ax = x + rng.range(-0.3, 0.3) * topW, az = z + rng.range(-0.3, 0.3) * topD;
      this.prop('antenna', ax, roofY, az, 0, rng.range(1, 2.5));
      this.lights.push({ pos: new THREE.Vector3(ax, roofY + 10, az), color: new THREE.Color(1, 0.05, 0.02), radius: 6, kind: 'other' });
    }
    if (d === 'neon' && h > 75 && rng.chance(0.25) && !this.landmarkSpots.some((l) => l.id === 'lm_pagoda' && l.pos.distanceTo(new THREE.Vector3(x, 0, z)) < 300)) {
      this.landmarkSpots.push({ id: 'lm_pagoda', pos: new THREE.Vector3(x, roofY, z), rot: 0, scale: Math.min(topW, topD) * 0.9, district: d });
    }
    if (interior) return;
    // street facing sides: (normal x, normal z, length, center offset)
    const sides: { nx: number; nz: number; len: number; on: boolean }[] = [
      { nx: 0, nz: -1, len: w, on: street.n || alley === 'alleyN' },
      { nx: 0, nz: 1, len: w, on: street.s || alley === 'alleyS' },
      { nx: -1, nz: 0, len: dz, on: street.w },
      { nx: 1, nz: 0, len: dz, on: street.e },
    ];
    for (const s of sides) {
      if (!s.on) continue;
      const half = s.nx !== 0 ? w / 2 : dz / 2;
      const fx = x + s.nx * half, fz = z + s.nz * half;
      const rot = Math.atan2(s.nx, s.nz); // rotation so local +Z faces the street
      const tx = -s.nz, tz = s.nx; // tangent along the facade
      this.decorateFacade(d, fx, fz, rot, tx, tz, s.nx, s.nz, s.len, h);
    }
    // big rooftop billboard
    if ((d === 'neon' || d === 'downtown') && h < 70 && rng.chance(0.22)) {
      const s = sides.find((q) => q.on);
      if (s) {
        const half = s.nx !== 0 ? w / 2 : dz / 2;
        this.addBillboard(x + s.nx * (half - 3), roofY + 4, z + s.nz * (half - 3), Math.atan2(s.nx, s.nz), rng.chance(0.2));
      }
    }
    if (d === 'downtown' && h > 120 && rng.chance(0.5)) {
      // giant vertical ad screen on the tower face
      const s = sides.find((q) => q.on);
      if (s) {
        const half = s.nx !== 0 ? w / 2 : dz / 2;
        const ids = Object.keys(this.adInfo).filter((k) => this.adInfo[k].aspect < 1);
        const id = rng.pick(ids);
        const ww = Math.min(s.len * 0.6, 26), hh = ww / this.adInfo[id].aspect;
        this.atlasQuad('ad', this.adInfo[id].uv, x + s.nx * (half + 0.3), rng.range(25, Math.max(30, h * 0.5 - hh / 2)) + hh / 2, z + s.nz * (half + 0.3), Math.atan2(s.nx, s.nz), ww, hh);
        this.lights.push({ pos: new THREE.Vector3(x + s.nx * (half + 8), 30, z + s.nz * (half + 8)), color: new THREE.Color(0.4, 0.6, 1), radius: 30, kind: 'sign' });
      }
    }
  }

  private atlasQuad(kind: 'sign' | 'ad' | 'shop', uv: number[], x: number, y: number, z: number, rot: number, w: number, h: number) {
    const [u, v, uw, vh] = uv;
    const glUv = [u, 1 - v - vh, uw, vh];
    this.b.add(`atlas:${kind}`, chunkOf(x, z), this.geo.quad, this.mats[kind], mtx(x, y, z, rot, w, h, 1), { aUv: glUv, aSeed: [this.rng.next()] });
  }

  private decorateFacade(d: DistrictId, fx: number, fz: number, rot: number, tx: number, tz: number, nx: number, nz: number, len: number, h: number) {
    const rng = this.rng;
    const shopIds = Object.keys(this.shopInfo);
    const shopW = 8.5, shopH = 5;
    const n = Math.floor((len - 1) / shopW);
    // ground floor shopfronts
    if (d !== 'docks') {
      for (let k = 0; k < n; k++) {
        const off = -((n - 1) * shopW) / 2 + k * shopW;
        const px = fx + tx * off + nx * 0.06, pz = fz + tz * off + nz * 0.06;
        const id = rng.pick(shopIds);
        this.atlasQuad('shop', this.shopInfo[id], px, CURB_H + shopH / 2, pz, rot, shopW - 0.1, shopH);
        if (rng.chance(0.35)) this.prop('awning', px, CURB_H + shopH + 0.35, pz, rot, 1);
        // spill light from shop interior onto the wet sidewalk
        if (rng.chance(0.6)) this.lights.push({ pos: new THREE.Vector3(px + nx * 2.5, 2.2, pz + nz * 2.5), color: new THREE.Color().setHSL(rng.range(0.05, 0.15), 0.6, 0.55), radius: 7, kind: 'other' });
        if (k % 2 === 0) this.spots.push({ x: px + nx * 4.5, z: pz + nz * 4.5, district: d, nx, nz });
      }
    }
    // neon signs
    const signCount = d === 'neon' ? Math.floor(len / 7) + rng.int(1, 3) : d === 'backstreets' ? Math.floor(len / 10) + 1 : d === 'downtown' ? rng.int(0, 2) : rng.int(0, 1);
    for (let k = 0; k < signCount; k++) {
      const vertical = rng.chance(d === 'neon' ? 0.5 : 0.35);
      const pool = vertical ? this.signIds.vertical : (rng.chance(d === 'neon' ? 0.4 : 0.15) ? this.signIds.cjk.filter((i) => this.signInfo[i].aspect >= 0.7) : this.signIds.horizontal);
      if (!pool.length) continue;
      const id = rng.pick(pool);
      const info = this.signInfo[id];
      const off = rng.range(-0.42, 0.42) * len;
      const sh = vertical ? rng.range(4, 9) : rng.range(1.4, 3.2);
      const sw = sh * info.aspect;
      const y = CURB_H + shopH + 1 + sh / 2 + rng.range(0, Math.min(h * 0.5, 18));
      if (y + sh / 2 > h) continue;
      const blade = vertical ? rng.chance(0.8) : rng.chance(0.4);
      let px: number, pz: number, r: number;
      if (blade) {
        // perpendicular to the facade, sticking out over the sidewalk
        px = fx + tx * off + nx * (sw / 2 + 0.6);
        pz = fz + tz * off + nz * (sw / 2 + 0.6);
        r = rot + Math.PI / 2;
        this.prop('sign_bracket', fx + tx * off, y + sh / 2 - 0.2, fz + tz * off, rot + Math.PI, 1);
      } else {
        px = fx + tx * off + nx * 0.25;
        pz = fz + tz * off + nz * 0.25;
        r = rot;
      }
      this.atlasQuad('sign', info.uv, px, y, pz, r, sw, sh);
      const c = new THREE.Color(info.color[0], info.color[1], info.color[2]);
      this.lights.push({ pos: new THREE.Vector3(fx + tx * off + nx * 3, y, fz + tz * off + nz * 3), color: c, radius: Math.min(16, 5 + sh * 1.6), kind: 'sign' });
      if (rng.chance(0.15)) this.sounds.push({ pos: new THREE.Vector3(px, y, pz), type: 'neon' });
    }
    if (d === 'neon' && rng.chance(0.3)) this.sounds.push({ pos: new THREE.Vector3(fx + nx * 4, 1.5, fz + nz * 4), type: 'crowd' });
    // docks: sodium floodlights on warehouse walls, with light cones spilling onto the street
    if (d === 'docks') {
      const n2 = Math.max(1, Math.floor(len / 18));
      for (let k = 0; k < n2; k++) {
        const off = -((n2 - 1) * 18) / 2 + k * 18;
        const lx = fx + tx * off + nx * 0.6, lz = fz + tz * off + nz * 0.6;
        const col = new THREE.Color(1.0, 0.5, 0.16);
        this.b.add('flood', chunkOf(lx, lz), this.geo.box, this.floodMat(), mtx(lx, 7.2, lz, rot, 1.4, 0.35, 0.5));
        this.b.add('cone', chunkOf(lx, lz), this.geo.cone, this.mats.cone, mtx(lx + nx * 1.5, 7.1, lz + nz * 1.5, 0, 4.5, 7.0, 4.5), { aColor: [col.r, col.g, col.b] }, LAYER_NO_REFLECT);
        this.lights.push({ pos: new THREE.Vector3(lx + nx * 4, 5.5, lz + nz * 4), color: col, radius: 16, kind: 'lamp' });
      }
      if (rng.chance(0.25)) {
        // big painted company number / hazard stripes read as emissive panel
        const id = rng.pick(this.signIds.horizontal);
        const info = this.signInfo[id];
        this.atlasQuad('sign', info.uv, fx + nx * 0.3, Math.min(h - 3, 10), fz + nz * 0.3, rot, 3 * info.aspect, 3);
      }
    }
    // drainpipes / pipes in backstreets
    if (d === 'backstreets' && rng.chance(0.5)) this.prop('pipes', fx + tx * rng.range(-0.4, 0.4) * len + nx * 0.2, CURB_H - 10 + Math.min(h, 20), fz + tz * rng.range(-0.4, 0.4) * len + nz * 0.2, rot, 1);
  }

  addBillboard(x: number, y: number, z: number, rot: number, video: boolean) {
    const ids = Object.keys(this.adInfo).filter((k) => this.adInfo[k].aspect > 1);
    this.prop('billboard_frame', x, y, z, rot + Math.PI, 1);
    const fx = Math.sin(rot), fz = Math.cos(rot);
    const px = x + fx * 0.05, pz = z + fz * 0.05;
    if (video) {
      const clips = ['bb_koi', 'bb_drink', 'bb_ramen'];
      const m = new THREE.Mesh(this.geo.quad, new THREE.MeshBasicMaterial({ color: 0x000000 }));
      m.position.set(px, y + 3.25, pz);
      m.rotation.y = rot;
      m.scale.set(12, 6.5, 1);
      this.chunks[chunkOf(x, z)].add(m);
      this.videoScreens.push({ mesh: m, clip: this.rng.pick(clips) });
    } else {
      const id = this.rng.pick(ids);
      this.atlasQuad('ad', this.adInfo[id].uv, px, y + 3.25, pz, rot, 12, 6.5);
    }
    this.lights.push({ pos: new THREE.Vector3(x + fx * 8, y - 2, z + fz * 8), color: new THREE.Color(0.7, 0.6, 1), radius: 22, kind: 'sign' });
  }

  private addAdTower(x: number, z: number, rot: number) {
    // free-standing tall video pylon in the plaza
    const h = 26;
    this.b.add('bld:megablock', chunkOf(x, z), this.geo.box, this.mats.fac_megablock, mtx(x, CURB_H, z, rot, 3, h, 3), { aRand: [0.1, 0.2, 0.9, 0.5] });
    this.phys.box(x, h / 2, z, 1.5, h / 2, 1.5);
    const m = new THREE.Mesh(this.geo.quad, new THREE.MeshBasicMaterial({ color: 0x000000 }));
    m.position.set(x, h - 4, z + 1.55);
    m.scale.set(9, 16, 1);
    this.chunks[chunkOf(x, z)].add(m);
    this.videoScreens.push({ mesh: m, clip: 'bb_eye' });
    const m2 = m.clone();
    m2.position.set(x, h - 4, z - 1.55);
    m2.rotation.y = Math.PI;
    this.chunks[chunkOf(x, z)].add(m2);
    this.videoScreens.push({ mesh: m2, clip: 'bb_eye' });
    this.lights.push({ pos: new THREE.Vector3(x, 10, z + 8), color: new THREE.Color(0.3, 0.9, 1), radius: 26, kind: 'sign' });
  }

  private buildDocksBlock(i: number, j: number, cx: number, cz: number, inner: number) {
    const rng = this.rng;
    const kind = rng.next();
    // loading bays at the kerb on each side of the block (mission spots)
    const edge = inner / 2 + SIDEWALK + 1.5;
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.spots.push({ x: cx + nx * edge, z: cz + nz * edge, district: 'docks', nx, nz });
    if (kind < 0.4) {
      // warehouse(s)
      const n = rng.int(1, 2);
      for (let k = 0; k < n; k++) {
        const w = n === 1 ? inner - 6 : inner / 2 - 4;
        const x = n === 1 ? cx : cx - inner / 4 + (k * inner) / 2;
        this.addBuilding('docks', x, cz, w, inner - rng.range(6, 20), { n: true, s: true, w: true, e: true }, false, null);
      }
    } else {
      // container yard: stacks of shipping containers
      const colors = [0x8a2a1a, 0x1d4f7a, 0xb85a12, 0x2a6a3a, 0x6d6d70, 0x7a1d4f, 0xa58a1a];
      for (let gx = -2; gx <= 2; gx++) for (let gz = -1; gz <= 1; gz++) {
        if (rng.chance(0.2)) continue;
        const x = cx + gx * 13 + rng.range(-1, 1), z = cz + gz * 22;
        const stack = rng.int(1, 4);
        for (let s = 0; s < 2; s++) for (let lv = 0; lv < stack; lv++) {
          const col = new THREE.Color(rng.pick(colors)).multiplyScalar(rng.range(0.7, 1.1));
          const m = mtx(x + s * 2.6 - 1.3, CURB_H + lv * 2.6, z + rng.range(-0.3, 0.3), rng.chance(0.1) ? 0.05 : 0);
          this.kit.container.forEach((p, pi) => this.b.add(`cont:${pi}`, chunkOf(x, z), p.geometry, this.containerMat(), m, { aTint: [col.r, col.g, col.b] }));
        }
        this.phys.box(x, (stack * 2.6) / 2, z, 2.7, (stack * 2.6) / 2, 3.1);
      }
      // floodlight tower
      const lx = cx + inner / 2 - 4, lz = cz + inner / 2 - 4;
      this.prop('lamp_post', lx, CURB_H, lz, Math.PI * 1.25, 2.4);
      this.lights.push({ pos: new THREE.Vector3(lx - 3, 18, lz - 3), color: new THREE.Color(1, 0.55, 0.2), radius: 34, kind: 'lamp' });
    }
    // gantry cranes along the waterfront (outer ring of the docks quadrant)
    if (i === GRID - 1 && j % 3 === 1) {
      this.landmarkSpots.push({ id: 'lm_crane', pos: new THREE.Vector3(HALF + 30, 0, cz), rot: Math.PI / 2, scale: 42, district: 'docks' });
    }
  }

  private _floodMat?: THREE.MeshStandardMaterial;
  private floodMat() {
    return (this._floodMat ??= new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(1, 0.55, 0.2), emissiveIntensity: 9 }));
  }
  private _contMat?: THREE.MeshStandardMaterial;
  private containerMat() {
    if (this._contMat) return this._contMat;
    const t = this.a.tex;
    const m = new THREE.MeshStandardMaterial({ map: t.rusted_metal_albedo, normalMap: t.rusted_metal_normal, roughnessMap: t.rusted_metal_rough, metalness: 0.5, envMap: this.opts.envMap, envMapIntensity: 0.6 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aTint; varying vec3 vTint;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvTint = aTint;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTint;').replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vTint * 2.2;');
    };
    // container box UVs come from Blender (no UV unwrapping): use triplanar-ish world uv via default; acceptable for rust breakup
    this._contMat = m;
    return m;
  }

  // ------------------------------------------------------------- street furniture
  private buildStreetFurniture() {
    const rng = this.rng;
    const lampOff = ROAD_W / 2 + 0.6;
    const spacing = 36;
    const coneAttr = (c: THREE.Color) => ({ aColor: [c.r, c.g, c.b] });
    for (let li = 0; li <= GRID; li++) {
      const c = lineCoord(li);
      for (const axis of [0, 1] as const) {
        // axis 0: road along z at x=c ; axis 1: road along x at z=c
        for (let s = -HALF + 20; s < HALF - 10; s += spacing) {
          const along = s + (li % 2) * (spacing / 2);
          const local = ((along + HALF) % PITCH + PITCH) % PITCH;
          if (local < ROAD_W / 2 + SIDEWALK + 2 || local > PITCH - ROAD_W / 2 - SIDEWALK - 2) continue; // skip intersections
          const side = (Math.floor((along + HALF) / spacing) % 2) ? 1 : -1;
          const x = axis === 0 ? c + side * lampOff : along;
          const z = axis === 0 ? along : c + side * lampOff;
          if (Math.abs(x) > HALF + 1 || Math.abs(z) > HALF + 1) continue;
          const d = districtOfBlock(Math.min(GRID - 1, Math.max(0, Math.floor((x + HALF) / PITCH))), Math.min(GRID - 1, Math.max(0, Math.floor((z + HALF) / PITCH))));
          if (axis === 0 && Math.abs(c - 0) < 1 && false) continue;
          // arm (local +Z) should point toward the road centre
          const dirX = axis === 0 ? -side : 0, dirZ = axis === 0 ? 0 : -side;
          const rot = Math.atan2(dirX, dirZ);
          this.prop('lamp_post', x, CURB_H, z, rot, 1);
          this.phys.cylinder(x, 3, z, 3, 0.15);
          const hx = x + dirX * 2, hz = z + dirZ * 2;
          const col = d === 'docks' || d === 'backstreets' ? new THREE.Color(1.0, 0.55, 0.22) : d === 'downtown' ? new THREE.Color(0.7, 0.85, 1.0) : rng.chance(0.5) ? new THREE.Color(1, 0.62, 0.35) : new THREE.Color(0.6, 0.8, 1);
          this.lights.push({ pos: new THREE.Vector3(hx, 7.4, hz), color: col, radius: 13, kind: 'lamp' });
          this.b.add('cone', chunkOf(x, z), this.geo.cone, this.mats.cone, mtx(hx, 7.45, hz, 0, 3.4, 7.3, 3.4), coneAttr(col), LAYER_NO_REFLECT);
          // other furniture between lamps
          const fx = axis === 0 ? c + side * (ROAD_W / 2 + 1.2) : along + spacing / 2;
          const fz = axis === 0 ? along + spacing / 2 : c + side * (ROAD_W / 2 + 1.2);
          const local2 = ((((axis === 0 ? fz : fx) + HALF) % PITCH) + PITCH) % PITCH;
          if (local2 < ROAD_W / 2 + SIDEWALK + 2 || local2 > PITCH - ROAD_W / 2 - SIDEWALK - 2) continue;
          const r = rng.next();
          if (r < 0.15) { this.prop('hydrant', fx, CURB_H, fz, rot); this.phys.cylinder(fx, 0.5, fz, 0.5, 0.25); }
          else if (r < 0.3) { this.prop('bin', fx, CURB_H, fz, 0); this.phys.cylinder(fx, 0.5, fz, 0.5, 0.33); }
          else if (r < 0.38 && (d === 'docks' || d === 'backstreets')) { this.prop('barrier', fx, CURB_H, fz, axis === 0 ? 0 : Math.PI / 2); this.phys.box(fx, 0.45, fz, axis === 0 ? 1.0 : 0.3, 0.45, axis === 0 ? 0.3 : 1.0); }
          else if (r < 0.5 && d !== 'docks') { this.prop('bench', fx + (axis === 0 ? side * 1.2 : 0), CURB_H, fz + (axis === 1 ? side * 1.2 : 0), rot + Math.PI); }
          else if (r < 0.6 && (d === 'backstreets' || d === 'neon')) {
            // steam vent in the road lane
            const vx = axis === 0 ? c + side * rng.range(1.5, 5) : fx, vz = axis === 0 ? fz : c + side * rng.range(1.5, 5);
            this.prop('vent', vx, 0.01, vz, 0);
            this.steam.push(new THREE.Vector3(vx, 0.1, vz));
            if (rng.chance(0.4)) this.sounds.push({ pos: new THREE.Vector3(vx, 0.5, vz), type: 'steam' });
          }
        }
      }
    }
    // alleys in backstreets: hanging cables + small lamps + steam
    for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
      if (districtOfBlock(i, j) !== 'backstreets') continue;
      const cz = blockCenter(j), x0 = lineCoord(i);
      for (let k = 1; k < 5; k++) {
        const x = x0 + (k * PITCH) / 5;
        const col = new THREE.Color().setHSL(rng.pick([0.02, 0.08, 0.9, 0.55]), 0.9, 0.55);
        this.lights.push({ pos: new THREE.Vector3(x, 5, cz + rng.range(-2, 2)), color: col, radius: 9, kind: 'lamp' });
        this.b.add('cone', chunkOf(x, cz), this.geo.cone, this.mats.cone, mtx(x, 5.5, cz, 0, 2.2, 5.4, 2.2), coneAttr(col), LAYER_NO_REFLECT);
        if (rng.chance(0.5)) { this.steam.push(new THREE.Vector3(x + 3, 0.1, cz + rng.range(-3, 3))); }
      }
      this.buildCables(x0 + 4, x0 + PITCH - 4, cz);
    }
    // traffic lights at intersections
    for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) {
      const cx = lineCoord(i), cz = lineCoord(j);
      if (Math.abs(cx) === HALF || Math.abs(cz) === HALF) continue;
      const offset = ((i * 7 + j * 13) % 24);
      const dirs: [number, number, number][] = [[0, 1, 1], [0, -1, 1], [1, 0, 0], [-1, 0, 0]]; // D toward intersection, axis
      for (const [Dx, Dz, axis] of dirs) {
        const rx = -Dz, rz = Dx; // right vector
        const px = cx - Dx * (ROAD_W / 2 + 1.6) + rx * (ROAD_W / 2 + 1.3);
        const pz = cz - Dz * (ROAD_W / 2 + 1.6) + rz * (ROAD_W / 2 + 1.3);
        const rot = Math.atan2(-rx, -rz);
        this.prop('traffic_light', px, CURB_H, pz, rot);
        ['tl_red', 'tl_amber', 'tl_green'].forEach((n, ci) => {
          this.kit[n].forEach((p) => this.b.add('tlamp', chunkOf(px, pz), p.geometry, this.mats.tlamp, mtx(px, CURB_H, pz, rot), { aPhase: [offset, axis, ci] }));
        });
        this.phys.cylinder(px, 3, pz, 3, 0.15);
      }
    }
  }

  private buildCables(x0: number, x1: number, z: number) {
    const pts: number[] = [];
    const rng = this.rng;
    for (let c = 0; c < 5; c++) {
      const y0 = rng.range(6, 12), sag = rng.range(0.6, 2), zz = z + rng.range(-4, 4), z2 = z + rng.range(-4, 4);
      const xa = x0 + rng.range(0, 30), xb = Math.min(x1, xa + rng.range(15, 50));
      let prev: number[] | null = null;
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const p = [xa + (xb - xa) * t, y0 - Math.sin(Math.PI * t) * sag, zz + (z2 - zz) * t];
        if (prev) pts.push(...prev, ...p);
        prev = p;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x050506 }));
    this.chunks[chunkOf((x0 + x1) / 2, z)].add(l);
  }

  // ------------------------------------------------------------- elevated rail
  private buildRail() {
    for (let x = -HALF - 160; x <= HALF + 160; x += 32) {
      this.prop('rail_track', x, 0, RAIL_Z, Math.PI / 2, 1);
      const local = ((x + HALF) % PITCH + PITCH) % PITCH;
      if (Math.abs(x) < HALF + 5 && local > ROAD_W && local < PITCH - ROAD_W) {
        this.prop('rail_portal', x, CURB_H, RAIL_Z, Math.PI / 2, 1);
        this.phys.box(x, 6, RAIL_Z - 8.6, 0.5, 6, 0.5);
        this.phys.box(x, 6, RAIL_Z + 8.6, 0.5, 6, 0.5);
      }
      if (Math.abs(x) % 96 < 1) this.lights.push({ pos: new THREE.Vector3(x, 12.5, RAIL_Z), color: new THREE.Color(0.2, 0.9, 1), radius: 14, kind: 'other' });
    }
  }

  // ------------------------------------------------------------- distant skyline ring
  private buildBackdrop() {
    const rng = this.rng;
    const facs = Object.keys(FACADES).filter((f) => f !== 'industrial');
    const geo = this.geo.box;
    const batches: Record<string, THREE.Matrix4[]> = {};
    const rands: Record<string, number[]> = {};
    const place = (x: number, z: number) => {
      if (x > HALF + 30 && z > -60) return; // water side of docks stays open
      const f = rng.pick(facs);
      const w = rng.range(20, 50), dd = rng.range(20, 50);
      const dist = Math.max(Math.abs(x), Math.abs(z)) - HALF;
      const h = rng.range(40, 200) * (1 + dist / 600);
      (batches[f] ??= []).push(mtx(x, 0, z, 0, w, h, dd).clone());
      (rands[f] ??= []).push(rng.next(), rng.next(), rng.next() * 0.6, rng.next());
    };
    for (let k = 0; k < 900; k++) {
      const ang = rng.range(0, Math.PI * 2);
      const r = rng.range(HALF + 60, HALF + 700);
      const x = Math.cos(ang) * r * 1.1, z = Math.sin(ang) * r * 1.1;
      if (Math.abs(x) < HALF + 50 && Math.abs(z) < HALF + 50) continue;
      place(x, z);
    }
    // far shore across the water
    for (let k = 0; k < 120; k++) place(HALF + rng.range(600, 900), rng.range(-200, HALF + 600));
    for (const [f, ms] of Object.entries(batches)) {
      const g = geo.clone();
      g.setAttribute('aRand', new THREE.InstancedBufferAttribute(new Float32Array(rands[f]), 4));
      const im = new THREE.InstancedMesh(g, this.mats[`fac_${f}`], ms.length);
      ms.forEach((m, i) => im.setMatrixAt(i, m));
      im.computeBoundingSphere();
      this.far.add(im);
    }
  }

  // ------------------------------------------------------------- district gates
  private buildGates() {
    for (const d of DISTRICT_ORDER.slice(1)) {
      const entry = { meshes: [] as THREE.Object3D[], colliders: [] as RAPIER.Collider[] };
      for (const g of districtGates(d)) {
        const grp = new THREE.Group();
        for (const p of this.kit.holo_barrier) {
          const m = new THREE.Mesh(p.geometry, p.material);
          grp.add(m);
        }
        grp.position.set(g.x, CURB_H * 0, g.z);
        grp.rotation.y = g.rot + Math.PI / 2;
        this.root.add(grp);
        entry.meshes.push(grp);
        const c = this.phys.world.createCollider(
          RAPIER.ColliderDesc.cuboid(g.rot ? 0.3 : 7.5, 2, g.rot ? 7.5 : 0.3).setTranslation(g.x, 2, g.z).setCollisionGroups(groups(GROUP_GATE, GROUP_CAR)),
        );
        entry.colliders.push(c);
        this.lights.push({ pos: new THREE.Vector3(g.x, 1.5, g.z), color: new THREE.Color(1, 0.05, 0.05), radius: 10, kind: 'other' });
      }
      this.gates[d] = entry;
    }
  }

  unlock(d: DistrictId) {
    const g = this.gates[d];
    if (!g) return;
    g.meshes.forEach((m) => m.removeFromParent());
    g.colliders.forEach((c) => this.phys.remove(c));
    this.lights = this.lights.filter((l) => !(l.kind === 'other' && l.color.g < 0.1 && l.color.r > 0.9 && g.meshes.some((m) => Math.abs(m.position.x - l.pos.x) < 0.1 && Math.abs(m.position.z - l.pos.z) < 0.1)));
    delete this.gates[d];
  }

  /** Show only chunks within view distance of the camera. */
  updateVisibility(cam: THREE.Vector3, viewDist: number) {
    const pad = PITCH * CHUNK_BLOCKS * 0.71;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunkCenters[i];
      const d = Math.hypot(c.x - cam.x, c.z - cam.z);
      this.chunks[i].visible = d < viewDist + pad;
      this.smallChunks[i].visible = d < 190 + pad;
    }
  }
}
