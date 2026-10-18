import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { kitParts } from '../core/assets';
import type { Physics } from '../core/physics';
import { RAPIER, groups, GROUP_TRAFFIC, GROUP_CAR, GROUP_WORLD, GROUP_HERO } from '../core/physics';
import { RoadGraph, GEdge, HALF, PITCH, lineCoord } from './layout';
import { trafficState } from '../render/specialMaterials';
import { createConeMaterial } from '../render/specialMaterials';
import { LAYER_NO_REFLECT } from '../render/reflector';
import { Rng } from './city';
import { type CarAsset, type CarDef, patchCarLights, carPaint } from '../vehicle/carModels';

const MODELS = ['car_sedan', 'car_taxi', 'car_van', 'car_hatch'] as const;

/** A traffic model: instanced parts (body + optional per-corner wheels) and its size. */
interface TModel {
  id: string; weight: number; length: number; width: number; height: number; wheelR: number;
  wheelPos: Record<string, THREE.Vector3>;
  parts: { im: THREE.InstancedMesh; wheel: string | null; brake?: THREE.InstancedBufferAttribute }[];
}
const PAINT = [0x1a1a1f, 0x8a8f99, 0x2b3f66, 0x5c1015, 0xd8d8dc, 0x0f3b2e, 0x3d2a52, 0x111111];

interface TCar {
  model: number;
  spin: number; braking: boolean; lastSpeed: number;
  edge: GEdge; from: number; // node we came from
  s: number; lane: number; speed: number; maxSpeed: number;
  // turning curve
  turning: boolean; t: number; curve?: THREE.QuadraticBezierCurve3; curveLen: number; nextEdge?: GEdge; nextFrom?: number;
  pos: THREE.Vector3; yaw: number;
  body: RAPIER.RigidBody;
  stunned: number;
  color: THREE.Color;
  honk: number;
}

export class Traffic {
  group = new THREE.Group();
  cars: TCar[] = [];
  private meshes: { im: THREE.InstancedMesh; model: number; paint: boolean }[] = [];
  models: TModel[] = [];
  private beams: THREE.InstancedMesh;
  private rng = new Rng(99);
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  onHonk: (p: THREE.Vector3) => void = () => {};

  constructor(private graph: RoadGraph, private phys: Physics, kit: GLTF, private count: number, private nodeIndex: (x: number, z: number) => [number, number] | null, cars: { asset: CarAsset; def: CarDef }[] = [], envMap: THREE.Texture | null = null) {
    // realistic generated cars (preferred)
    for (const { asset, def } of cars) {
      if (def.traffic <= 0) continue;
      const sp = asset.spec;
      const m: TModel = {
        id: def.id, weight: def.traffic, length: sp.length, width: sp.width, height: sp.height, wheelR: sp.wheelRadius,
        wheelPos: Object.fromEntries(Object.entries(sp.wheels).map(([k, v]) => [k, new THREE.Vector3(...v)])), parts: [],
      };
      const mk = (geo: THREE.BufferGeometry, src: THREE.Material, wheel: string | null) => {
        let mat: THREE.Material = src;
        let brake: THREE.InstancedBufferAttribute | undefined;
        const g = geo.clone();
        if (src.name !== 'liner' && (src as THREE.MeshStandardMaterial).map) {
          const pm = carPaint(src as THREE.MeshStandardMaterial, envMap);
          pm.clearcoat = 0.6;
          if (!wheel) {
            patchCarLights(pm, sp.length / 2, true);
            brake = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
            g.setAttribute('aBrake', brake);
          }
          mat = pm;
        }
        const im = new THREE.InstancedMesh(g, mat, count);
        im.count = 0;
        im.frustumCulled = false;
        this.group.add(im);
        m.parts.push({ im, wheel, brake });
      };
      for (const b of asset.body) mk(b.geometry, b.material, null);
      for (const [k, list] of Object.entries(asset.wheels)) for (const w of list) mk(w.geometry, w.material, k);
      this.models.push(m);
    }
    if (!this.models.length) MODELS.forEach((name, mi) => {
      for (const part of [...kitParts(kit, name), ...kitParts(kit, `${name}_glass`)]) {
        const mat = (part.material as THREE.MeshStandardMaterial).clone();
        const paint = mat.name.startsWith('paint_') && name !== 'car_taxi';
        if (mat.name.startsWith('emit_')) mat.emissiveIntensity = 6;
        if (mat.name === 'glass') { mat.transparent = true; mat.opacity = 0.75; mat.color.set(0x05070a); }
        if (paint) mat.color.set(0xffffff);
        const im = new THREE.InstancedMesh(part.geometry, mat, count);
        im.count = 0;
        im.frustumCulled = false;
        if (paint) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
        this.group.add(im);
        this.meshes.push({ im, model: mi, paint });
      }
    });
    const beamGeo = new THREE.ConeGeometry(1, 1, 16, 1, true);
    beamGeo.translate(0, -0.5, 0);
    beamGeo.rotateX(-Math.PI / 2);
    beamGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(count * 6).fill(0.9), 3));
    this.beams = new THREE.InstancedMesh(beamGeo, createConeMaterial(0.035), count * 2);
    this.beams.frustumCulled = false;
    this.beams.layers.set(LAYER_NO_REFLECT);
    this.group.add(this.beams);
  }

  private lanePoint(e: GEdge, from: number, s: number, lane: number, out = new THREE.Vector3()) {
    const A = this.graph.nodes[from], B = this.graph.nodes[this.graph.other(e, from)];
    const dx = (B.x - A.x) / e.len, dz = (B.z - A.z) / e.len;
    const off = e.alley ? 1.9 : lane === 0 ? 1.75 : 5.25;
    return out.set(A.x + dx * s - dz * off, 0, A.z + dz * s + dx * off);
  }

  private spawn(near: THREE.Vector3, minD: number, maxD: number): TCar | null {
    for (let tries = 0; tries < 30; tries++) {
      const e = this.graph.edges[Math.floor(this.rng.next() * this.graph.edges.length)];
      const A = this.graph.nodes[e.a];
      const d = Math.hypot(A.x - near.x, A.z - near.z);
      if (d < minD || d > maxD) continue;
      const from = this.rng.chance(0.5) ? e.a : e.b;
      const lane = this.rng.chance(0.5) ? 0 : 1;
      const s = this.rng.range(12, Math.max(13, e.len - 14));
      const pos = this.lanePoint(e, from, s, lane);
      if (this.cars.some((c) => c.pos.distanceToSquared(pos) < 100)) continue;
      let model = this.rng.int(0, MODELS.length - 1);
      let hw = model === 2 ? 1.0 : 0.9, hh = model === 2 ? 1.0 : 0.72, hl = model === 2 ? 2.6 : 2.25;
      if (this.models.length) {
        // weighted pick among generated models
        let r = this.rng.next() * this.models.reduce((a, m) => a + m.weight, 0);
        model = 0;
        for (let i = 0; i < this.models.length; i++) { r -= this.models[i].weight; if (r <= 0) { model = i; break; } }
        const M = this.models[model];
        hw = M.width * 0.45; hh = M.height * 0.42; hl = M.length * 0.48;
      }
      const body = this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, 0, pos.z));
      this.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(hw, hh, hl).setTranslation(0, hh + 0.15, 0).setFriction(0.3).setCollisionGroups(groups(GROUP_TRAFFIC, GROUP_CAR | GROUP_WORLD | GROUP_HERO)), body);
      const B = this.graph.nodes[this.graph.other(e, from)];
      return {
        model, edge: e, from, s, lane, speed: 8, maxSpeed: e.alley ? 7 : this.rng.range(11, 17), turning: false, t: 0, curveLen: 0,
        pos, yaw: Math.atan2(B.x - this.graph.nodes[from].x, B.z - this.graph.nodes[from].z), body, stunned: 0,
        color: new THREE.Color(this.rng.pick(PAINT)), honk: 0, spin: 0, braking: false, lastSpeed: 8,
      };
    }
    return null;
  }

  private pickNext(c: TCar) {
    const to = this.graph.other(c.edge, c.from);
    const node = this.graph.nodes[to];
    const options = node.edges.map((id) => this.graph.edges[id]).filter((e) => e.id !== c.edge.id);
    // avoid leaving the map through the outer ring corners etc. – just pick randomly, prefer straight
    if (!options.length) return { e: c.edge, from: to };
    const A = this.graph.nodes[c.from];
    const dirIn = new THREE.Vector2(node.x - A.x, node.z - A.z).normalize();
    const scored = options.map((e) => {
      const n2 = this.graph.nodes[this.graph.other(e, to)];
      const d = new THREE.Vector2(n2.x - node.x, n2.z - node.z).normalize();
      return { e, w: (d.dot(dirIn) > 0.9 ? 2.2 : 1) * (e.alley ? 0.4 : 1) };
    });
    let r = this.rng.next() * scored.reduce((s, o) => s + o.w, 0);
    for (const o of scored) { r -= o.w; if (r <= 0) return { e: o.e, from: to }; }
    return { e: scored[0].e, from: to };
  }

  private redLight(c: TCar): boolean {
    const to = this.graph.nodes[this.graph.other(c.edge, c.from)];
    if (c.edge.alley || to.alley) return false;
    if (Math.abs(to.x) >= HALF - 1 || Math.abs(to.z) >= HALF - 1) return false;
    const idx = this.nodeIndex(to.x, to.z);
    if (!idx) return false;
    const [i, j] = idx;
    const offset = (i * 7 + j * 13) % 24;
    const A = this.graph.nodes[c.from];
    const axis = Math.abs(to.x - A.x) > Math.abs(to.z - A.z) ? 0 : 1;
    return trafficState(axis, this.time, offset) !== 2;
  }

  time = 0;
  update(dt: number, player: THREE.Vector3, playerVel: THREE.Vector3, playerBody: RAPIER.RigidBody) {
    this.time += dt;
    // maintain population
    for (let k = this.cars.length - 1; k >= 0; k--) {
      const c = this.cars[k];
      if (c.pos.distanceTo(player) > 330) {
        this.phys.world.removeRigidBody(c.body);
        this.cars.splice(k, 1);
      }
    }
    let guard = 0;
    while (this.cars.length < this.count && guard++ < 4) {
      const c = this.spawn(player, this.cars.length < this.count / 2 ? 40 : 120, 300);
      if (c) this.cars.push(c);
    }

    for (const c of this.cars) {
      // desired speed: car ahead, player ahead, red lights
      let target = c.maxSpeed;
      const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
      for (const o of this.cars) {
        if (o === c) continue;
        const d = o.pos.clone().sub(c.pos);
        const ahead = d.dot(fwd);
        if (ahead < 0 || ahead > 18) continue;
        const lat = Math.abs(d.x * fwd.z - d.z * fwd.x);
        if (lat > 1.8) continue;
        target = Math.min(target, Math.max(0, (ahead - 6.5) * 1.2));
      }
      {
        const d = player.clone().sub(c.pos);
        const ahead = d.dot(fwd);
        const lat = Math.abs(d.x * fwd.z - d.z * fwd.x);
        if (ahead > 0 && ahead < 16 && lat < 2.2) {
          target = Math.min(target, Math.max(0, (ahead - 7) * 1.2));
          if (ahead < 9 && c.honk <= 0 && playerVel.length() < 3) { c.honk = 4; this.onHonk(c.pos); }
        }
      }
      c.honk -= dt;
      if (!c.turning && c.edge.len - c.s < 22 && c.edge.len - c.s > 9 && this.redLight(c)) {
        target = Math.min(target, Math.max(0, (c.edge.len - 11.5 - c.s) * 1.1));
      }
      if (c.stunned > 0) { c.stunned -= dt; target = 0; }
      c.speed += THREE.MathUtils.clamp(target - c.speed, -9 * dt, 3 * dt);
      c.speed = Math.max(0, c.speed);
      const ds = c.speed * dt;

      if (!c.turning) {
        c.s += ds;
        if (c.s >= c.edge.len - 9) {
          const nx = this.pickNext(c);
          const p0 = this.lanePoint(c.edge, c.from, c.edge.len - 9, c.lane);
          const p2 = this.lanePoint(nx.e, nx.from, Math.min(9, nx.e.len / 2), c.lane);
          const node = this.graph.nodes[nx.from];
          const inDir = new THREE.Vector3(node.x - this.graph.nodes[c.from].x, 0, node.z - this.graph.nodes[c.from].z).normalize();
          // control point: where the incoming lane line meets the outgoing lane line
          const p1 = p0.clone().addScaledVector(inDir, 9);
          const outEnd = this.graph.nodes[this.graph.other(nx.e, nx.from)];
          const outDir = new THREE.Vector3(outEnd.x - node.x, 0, outEnd.z - node.z).normalize();
          if (Math.abs(inDir.dot(outDir)) < 0.5) p1.copy(p2).addScaledVector(outDir, -Math.min(9, nx.e.len / 2));
          c.curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);
          c.curveLen = c.curve.getLength();
          c.turning = true;
          c.t = 0;
          c.nextEdge = nx.e;
          c.nextFrom = nx.from;
        } else {
          this.lanePoint(c.edge, c.from, c.s, c.lane, c.pos);
          const B = this.graph.nodes[this.graph.other(c.edge, c.from)], A = this.graph.nodes[c.from];
          c.yaw = Math.atan2(B.x - A.x, B.z - A.z);
        }
      }
      if (c.turning && c.curve) {
        c.t += ds / Math.max(1, c.curveLen);
        if (c.t >= 1) {
          c.turning = false;
          c.edge = c.nextEdge!;
          c.from = c.nextFrom!;
          c.s = Math.min(9, c.edge.len / 2);
          if (c.edge.alley) c.maxSpeed = 7; else if (c.maxSpeed < 9) c.maxSpeed = this.rng.range(11, 17);
        } else {
          c.curve.getPoint(c.t, c.pos);
          const tan = c.curve.getTangent(c.t);
          c.yaw = Math.atan2(tan.x, tan.z);
        }
      }
      c.body.setNextKinematicTranslation({ x: c.pos.x, y: 0, z: c.pos.z });
      c.body.setNextKinematicRotation({ x: 0, y: Math.sin(c.yaw / 2), z: 0, w: Math.cos(c.yaw / 2) });
    }

    if (this.models.length) { this.renderModels(dt); void playerBody; return; }
    // render (legacy kit models)
    const counts = new Map<THREE.InstancedMesh, number>();
    for (const m of this.meshes) { m.im.count = 0; counts.set(m.im, 0); }
    let bi = 0;
    for (const c of this.cars) {
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw);
      this.m4.compose(c.pos, this.q, new THREE.Vector3(1, 1, 1));
      for (const m of this.meshes) {
        if (m.model !== c.model) continue;
        const i = counts.get(m.im)!;
        m.im.setMatrixAt(i, this.m4);
        if (m.paint) m.im.setColorAt(i, c.color);
        counts.set(m.im, i + 1);
      }
      for (const sx of [0.62, -0.62]) {
        const p = new THREE.Vector3(sx, 0.75, 2.3).applyQuaternion(this.q).add(c.pos);
        this.beams.setMatrixAt(bi++, new THREE.Matrix4().compose(p, this.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, 0, 0))), new THREE.Vector3(3.2, 2.4, 16)));
      }
    }
    for (const m of this.meshes) {
      m.im.count = counts.get(m.im)!;
      m.im.instanceMatrix.needsUpdate = true;
      if (m.paint && m.im.instanceColor) m.im.instanceColor.needsUpdate = true;
    }
    this.beams.count = Math.min(bi, this.count * 2);
    this.beams.instanceMatrix.needsUpdate = true;
    void playerBody; void PITCH; void lineCoord;
  }

  private wm = new THREE.Matrix4();
  private wq = new THREE.Quaternion();
  private renderModels(dt: number) {
    const cnt = this.models.map((m) => 0);
    for (const M of this.models) for (const p of M.parts) p.im.count = 0;
    let bi = 0;
    const one = new THREE.Vector3(1, 1, 1);
    for (const c of this.cars) {
      const M = this.models[c.model];
      const i = cnt[c.model]++;
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw);
      this.m4.compose(c.pos, this.q, one);
      c.spin += (c.speed / M.wheelR) * dt;
      c.braking = c.speed < c.lastSpeed - 0.05 || c.speed < 0.3;
      c.lastSpeed = c.speed;
      const steer = c.turning && c.curve ? THREE.MathUtils.clamp(-(c.curve.getTangent(Math.min(1, c.t + 0.15)).cross(c.curve.getTangent(c.t)).y) * 6, -0.5, 0.5) : 0;
      for (const p of M.parts) {
        if (p.wheel) {
          const wp = M.wheelPos[p.wheel];
          this.wq.setFromEuler(new THREE.Euler(c.spin, p.wheel[0] === 'F' ? steer : 0, 0, 'YXZ'));
          this.wm.compose(wp, this.wq, one).premultiply(this.m4);
          p.im.setMatrixAt(i, this.wm);
        } else {
          p.im.setMatrixAt(i, this.m4);
          if (p.brake) p.brake.setX(i, c.braking ? 1 : 0);
        }
        p.im.count = cnt[c.model];
      }
      const hx = M.width * 0.33, hz = M.length / 2 - 0.1, hy = M.height * 0.45;
      for (const sx of [hx, -hx]) {
        const p = new THREE.Vector3(sx, hy, hz).applyQuaternion(this.q).add(c.pos);
        this.beams.setMatrixAt(bi++, new THREE.Matrix4().compose(p, this.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, 0, 0))), new THREE.Vector3(3.2, 2.4, 16)));
      }
    }
    for (const M of this.models) for (const p of M.parts) {
      p.im.instanceMatrix.needsUpdate = true;
      if (p.brake) p.brake.needsUpdate = true;
    }
    this.beams.count = Math.min(bi, this.count * 2);
    this.beams.instanceMatrix.needsUpdate = true;
  }

  /** Light sources from traffic headlights/taillights for the ground light pool. */
  lightSources(out: { pos: THREE.Vector3; color: THREE.Color; radius: number }[]) {
    for (const c of this.cars) {
      const f = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
      out.push({ pos: c.pos.clone().addScaledVector(f, 7).setY(1.0), color: new THREE.Color(0.9, 0.92, 1).multiplyScalar(0.9), radius: 9 });
      out.push({ pos: c.pos.clone().addScaledVector(f, -3).setY(0.8), color: new THREE.Color(1, 0.05, 0.03), radius: 4 });
    }
  }

  /** Remove a traffic car (it is being stolen); returns its model id and pose. */
  takeCar(c: TCar) {
    const i = this.cars.indexOf(c);
    if (i < 0) return null;
    this.cars.splice(i, 1);
    this.phys.world.removeRigidBody(c.body);
    return { id: this.models[c.model]?.id ?? 'car_taxi', pos: c.pos.clone(), yaw: c.yaw, speed: c.speed };
  }

  /** Nearest traffic car to p within r, with its driver-door point. */
  nearestCar(p: THREE.Vector3, r: number) {
    let best: TCar | null = null, bd = r;
    for (const c of this.cars) {
      const M = this.models[c.model];
      const hw = (M?.width ?? 1.9) / 2 + 0.55;
      const door = new THREE.Vector3(hw, 0, 0.35).applyAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw).add(c.pos);
      const d = door.distanceTo(p);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  hit(body: RAPIER.RigidBody) {
    const c = this.cars.find((q) => q.body.handle === body.handle);
    if (c) { c.stunned = 2.5; c.speed = 0; }
    return c;
  }
}
