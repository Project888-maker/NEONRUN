import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { kitParts } from '../core/assets';
import type { Physics } from '../core/physics';
import { RAPIER, groups, GROUP_TRAFFIC, GROUP_CAR, GROUP_WORLD } from '../core/physics';
import { RoadGraph, GEdge, HALF, PITCH, lineCoord } from './layout';
import { trafficState } from '../render/specialMaterials';
import { createConeMaterial } from '../render/specialMaterials';
import { LAYER_NO_REFLECT } from '../render/reflector';
import { Rng } from './city';

const MODELS = ['car_sedan', 'car_taxi', 'car_van', 'car_hatch'] as const;
const PAINT = [0x1a1a1f, 0x8a8f99, 0x2b3f66, 0x5c1015, 0xd8d8dc, 0x0f3b2e, 0x3d2a52, 0x111111];

interface TCar {
  model: number;
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
  private beams: THREE.InstancedMesh;
  private rng = new Rng(99);
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  onHonk: (p: THREE.Vector3) => void = () => {};

  constructor(private graph: RoadGraph, private phys: Physics, kit: GLTF, private count: number, private nodeIndex: (x: number, z: number) => [number, number] | null) {
    MODELS.forEach((name, mi) => {
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
      const model = this.rng.int(0, MODELS.length - 1);
      const body = this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, 0, pos.z));
      const hw = model === 2 ? 1.0 : 0.9, hh = model === 2 ? 1.0 : 0.72, hl = model === 2 ? 2.6 : 2.25;
      this.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(hw, hh, hl).setTranslation(0, hh + 0.15, 0).setFriction(0.3).setCollisionGroups(groups(GROUP_TRAFFIC, GROUP_CAR | GROUP_WORLD)), body);
      const B = this.graph.nodes[this.graph.other(e, from)];
      return {
        model, edge: e, from, s, lane, speed: 8, maxSpeed: e.alley ? 7 : this.rng.range(11, 17), turning: false, t: 0, curveLen: 0,
        pos, yaw: Math.atan2(B.x - this.graph.nodes[from].x, B.z - this.graph.nodes[from].z), body, stunned: 0,
        color: new THREE.Color(this.rng.pick(PAINT)), honk: 0,
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

    // render
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

  /** Light sources from traffic headlights/taillights for the ground light pool. */
  lightSources(out: { pos: THREE.Vector3; color: THREE.Color; radius: number }[]) {
    for (const c of this.cars) {
      const f = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
      out.push({ pos: c.pos.clone().addScaledVector(f, 7).setY(1.0), color: new THREE.Color(0.9, 0.92, 1).multiplyScalar(0.9), radius: 9 });
      out.push({ pos: c.pos.clone().addScaledVector(f, -3).setY(0.8), color: new THREE.Color(1, 0.05, 0.03), radius: 4 });
    }
  }

  hit(body: RAPIER.RigidBody) {
    const c = this.cars.find((q) => q.body.handle === body.handle);
    if (c) { c.stunned = 2.5; c.speed = 0; }
    return c;
  }
}
