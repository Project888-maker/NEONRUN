import * as THREE from 'three';
import type { Physics } from '../core/physics';
import { RAPIER, groups, GROUP_TRAFFIC, GROUP_CAR, GROUP_WORLD } from '../core/physics';
import type { RoadGraph } from '../world/layout';
import type { CarAsset } from '../vehicle/carModels';
import { carPaint, patchCarLights } from '../vehicle/carModels';
import { LAYER_NO_REFLECT } from '../render/reflector';

interface Unit {
  root: THREE.Group; wheels: THREE.Object3D[]; bar: THREE.Sprite[];
  body: RAPIER.RigidBody; pos: THREE.Vector3; yaw: number; speed: number;
  route: THREE.Vector3[]; routeT: number; spin: number; spoke: number;
}

function glowTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** A standalone (non-instanced) car mesh from a generated car asset: body + four wheel pivots (FL, FR, RL, RR). */
export function carMesh(asset: CarAsset, envMap: THREE.Texture | null) {
  const sp = asset.spec;
  const root = new THREE.Group();
  for (const b of asset.body) {
    let mat = b.material;
    if ((mat as THREE.MeshStandardMaterial).map) { const pm = carPaint(mat as THREE.MeshStandardMaterial, envMap); patchCarLights(pm, sp.length / 2, false); mat = pm; }
    root.add(new THREE.Mesh(b.geometry, mat));
  }
  const wheels: THREE.Object3D[] = [];
  for (const k of ['FL', 'FR', 'RL', 'RR'] as const) {
    const piv = new THREE.Group();
    piv.position.set(...sp.wheels[k]);
    for (const w of asset.wheels[k]) piv.add(new THREE.Mesh(w.geometry, w.material));
    root.add(piv);
    wheels.push(piv);
  }
  return { root, wheels };
}

/** Wanted level + pursuing police cruisers. */
export class Police {
  group = new THREE.Group();
  heat = 0;
  units: Unit[] = [];
  light: THREE.PointLight;
  private evade = 0;
  /** parked cruisers blocking a junction ahead of the player (heat 3+) */
  private blocks: { units: Unit[]; age: number; at: THREE.Vector3 }[] = [];
  private blockT = 8;
  onRoadblock: (pos: THREE.Vector3) => void = () => {};
  private bustT = 0;
  private spawnT = 0;
  private tex = glowTex();
  onBusted: () => void = () => {};
  onSpawn: (pos: THREE.Vector3) => void = () => {};
  onHeat: (h: number) => void = () => {};

  constructor(private phys: Physics, private graph: RoadGraph, private asset: CarAsset | undefined, private envMap: THREE.Texture | null) {
    this.light = new THREE.PointLight(0xff0000, 0, 30, 2);
    this.group.add(this.light);
  }

  add(n: number, reason: string) {
    const prev = this.heat;
    this.heat = Math.min(5, this.heat + n);
    this.evade = 0;
    if (this.heat !== prev) this.onHeat(this.heat);
    void reason;
  }

  clear() {
    this.heat = 0;
    this.onHeat(0);
    for (const u of this.units) this.removeUnit(u);
    this.units = [];
    for (const b of this.blocks) b.units.forEach((u) => this.removeUnit(u));
    this.blocks = [];
  }

  /** Two cruisers parked nose-to-nose across the road at a junction 80–150 m ahead of where the player is heading. */
  private spawnRoadblock(player: THREE.Vector3, vel: THREE.Vector3) {
    if (vel.length() < 6) return;
    const dir = vel.clone().setY(0).normalize();
    let best: { x: number; z: number } | null = null, bs = -Infinity;
    for (const n of this.graph.nodes) {
      if (n.alley) continue;
      const rel = new THREE.Vector3(n.x - player.x, 0, n.z - player.z);
      const d = rel.length();
      if (d < 80 || d > 150) continue;
      const align = rel.normalize().dot(dir);
      if (align < 0.9) continue;
      if (align - d / 1000 > bs) { bs = align - d / 1000; best = n; }
    }
    if (!best) return;
    const at = new THREE.Vector3(best.x, 0, best.z);
    if (this.blocks.some((b) => b.at.distanceTo(at) < 5)) return;
    // the road the player is on runs along the dominant axis of travel; block it just before the junction
    const along = Math.abs(dir.x) > Math.abs(dir.z) ? new THREE.Vector3(Math.sign(dir.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(dir.z));
    const across = new THREE.Vector3(along.z, 0, -along.x);
    const c = at.clone().addScaledVector(along, -14);
    const units: Unit[] = [];
    for (const side of [-1, 1]) {
      const p = c.clone().addScaledVector(across, side * 3.2);
      const yaw = Math.atan2(across.x * -side, across.z * -side) + side * 0.5;
      const u = this.makeUnit(p, yaw);
      if (!u) continue;
      u.speed = 0;
      u.body.setNextKinematicTranslation({ x: p.x, y: 0, z: p.z });
      u.body.setNextKinematicRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      u.root.position.copy(p);
      u.root.rotation.y = yaw;
      units.push(u);
    }
    if (units.length) { this.blocks.push({ units, age: 0, at }); this.onRoadblock(c); }
  }

  private removeUnit(u: Unit) {
    u.root.removeFromParent();
    this.phys.world.removeRigidBody(u.body);
  }

  private makeUnit(pos: THREE.Vector3, yaw: number): Unit | null {
    if (!this.asset) return null;
    const sp = this.asset.spec;
    const { root, wheels } = carMesh(this.asset, this.envMap);
    // light bar glow sprites (red / blue)
    const bar: THREE.Sprite[] = [];
    for (const [x, col] of [[0.35, 0xff1020], [-0.35, 0x2050ff]] as const) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: new THREE.Color(col).multiplyScalar(4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.position.set(x, sp.height + 0.05, -0.15);
      s.scale.setScalar(1.4);
      s.layers.enable(LAYER_NO_REFLECT);
      root.add(s);
      bar.push(s);
    }
    this.group.add(root);
    const body = this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, 0, pos.z));
    this.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(sp.width * 0.44, sp.height * 0.4, sp.length * 0.48).setTranslation(0, sp.height * 0.42, 0).setFriction(0.4)
      .setCollisionGroups(groups(GROUP_TRAFFIC, GROUP_CAR | GROUP_WORLD)), body);
    return { root, wheels, bar, body, pos: pos.clone(), yaw, speed: 10, route: [], routeT: 0, spin: 0, spoke: Math.random() * 10 };
  }

  private spawnNear(player: THREE.Vector3) {
    // a road node 110-180 m away, ideally behind the player
    const cand = this.graph.nodes.filter((n) => { const d = Math.hypot(n.x - player.x, n.z - player.z); return d > 110 && d < 180; });
    if (!cand.length) return;
    const n = cand[Math.floor(Math.random() * cand.length)];
    const u = this.makeUnit(new THREE.Vector3(n.x, 0, n.z), Math.atan2(player.x - n.x, player.z - n.z));
    if (!u) return;
    this.units.push(u);
    this.onSpawn(u.pos);
  }

  /** player: position/velocity; onFoot: arrests faster */
  update(dt: number, t: number, player: THREE.Vector3, playerVel: THREE.Vector3, onFoot: boolean) {
    const want = Math.min(4, this.heat > 0 ? this.heat : 0);
    this.spawnT -= dt;
    if (this.units.length < want && this.spawnT <= 0) { this.spawnNear(player); this.spawnT = 4; }
    while (this.units.length > want) { const u = this.units.pop()!; this.removeUnit(u); }

    let nearest = Infinity;
    let nearestUnit: Unit | null = null;
    for (const u of this.units) {
      const d = u.pos.distanceTo(player);
      if (d < nearest) { nearest = d; nearestUnit = u; }
      // route along the road graph, direct pursuit when close
      u.routeT -= dt;
      if (u.routeT <= 0) {
        u.routeT = 1.5;
        const a = this.graph.nearestNode(u.pos.x, u.pos.z), b = this.graph.nearestNode(player.x, player.z);
        u.route = this.graph.route(a, b).map((i) => new THREE.Vector3(this.graph.nodes[i].x, 0, this.graph.nodes[i].z));
        // the nearest node is often already behind the cruiser: chasing it made units U-turn and orbit junctions
        const f = new THREE.Vector3(Math.sin(u.yaw), 0, Math.cos(u.yaw));
        while (u.route.length > 1 && u.route[0].clone().sub(u.pos).dot(f) < 4) u.route.shift();
      }
      // close in on a point behind the player (each unit takes its own slot) instead of aiming at the car itself:
      // police are kinematic, so touching the player's car would launch it
      const pv = playerVel.clone().setY(0);
      const back = pv.lengthSq() > 4 ? pv.clone().normalize().multiplyScalar(-1) : player.clone().sub(u.pos).setY(0).normalize().multiplyScalar(-1);
      const side = new THREE.Vector3(-back.z, 0, back.x).multiplyScalar(((this.units.indexOf(u) % 3) - 1) * 3.2);
      let target = player.clone().addScaledVector(back, 9).add(side);
      if (d > 38) {
        while (u.route.length && u.route[0].distanceTo(u.pos) < 12) u.route.shift();
        if (u.route.length) target = u.route[0];
      }
      const to = target.clone().sub(u.pos).setY(0);
      const dist = to.length();
      const desiredYaw = Math.atan2(to.x, to.z);
      let dy = desiredYaw - u.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      u.yaw += THREE.MathUtils.clamp(dy, -dt * 2.4, dt * 2.4);
      // near the player: match their speed (a little faster to keep up), never faster than that
      const maxV = d < 25 ? Math.max(2, pv.length() + (d > 12 ? 4 : 1)) : 28;
      const corner = Math.max(0.35, 1 - Math.abs(dy) * 0.9);
      u.speed = THREE.MathUtils.lerp(u.speed, Math.min(maxV, dist * 1.5) * corner, Math.min(1, dt * 1.6));
      const step = new THREE.Vector3(Math.sin(u.yaw), 0, Math.cos(u.yaw)).multiplyScalar(u.speed * dt);
      // contact guard: never move into the player's car (or another cruiser)
      const next = u.pos.clone().add(step);
      const blocked = next.distanceTo(player) < 6.2 && next.distanceTo(player) < u.pos.distanceTo(player)
        || this.units.some((o) => o !== u && next.distanceTo(o.pos) < 5.5 && next.distanceTo(o.pos) < u.pos.distanceTo(o.pos));
      if (blocked) u.speed = 0; else u.pos.copy(next);
      u.body.setNextKinematicTranslation({ x: u.pos.x, y: 0, z: u.pos.z });
      u.body.setNextKinematicRotation({ x: 0, y: Math.sin(u.yaw / 2), z: 0, w: Math.cos(u.yaw / 2) });
      u.root.position.copy(u.pos);
      u.root.rotation.y = u.yaw;
      u.spin += (u.speed / (this.asset?.spec.wheelRadius ?? 0.36)) * dt;
      u.wheels.forEach((w, i) => { w.rotation.set(u.spin, i < 2 ? THREE.MathUtils.clamp(dy, -0.5, 0.5) : 0, 0, 'YXZ'); });
      const ph = Math.floor((t + u.spoke) * 6) % 2;
      u.bar[0].material.opacity = ph ? 1 : 0.1;
      u.bar[1].material.opacity = ph ? 0.1 : 1;
    }
    // roadblocks
    if (this.heat >= 3) {
      this.blockT -= dt;
      if (this.blockT <= 0 && this.blocks.length < 2) { this.blockT = 22; this.spawnRoadblock(player, playerVel); }
    }
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      b.age += dt;
      const d = b.at.distanceTo(player);
      if (d < nearest) { nearest = d; nearestUnit = b.units[0]; }
      for (const u of b.units) {
        const ph = Math.floor((t + u.spoke) * 6) % 2;
        u.bar[0].material.opacity = ph ? 1 : 0.1;
        u.bar[1].material.opacity = ph ? 0.1 : 1;
      }
      if (this.heat === 0 || d > 260 || b.age > 70) { b.units.forEach((u) => this.removeUnit(u)); this.blocks.splice(i, 1); }
    }
    // shared flashing light at the nearest cruiser
    if (nearestUnit) {
      this.light.position.copy(nearestUnit.pos).add(new THREE.Vector3(0, 2.5, 0));
      const ph = Math.floor(t * 6) % 2;
      this.light.color.set(ph ? 0xff1020 : 0x2050ff);
      this.light.intensity = 120;
    } else this.light.intensity = 0;

    // busted / evade
    const slow = playerVel.length() < (onFoot ? 99 : 3);
    if (this.heat > 0 && nearest < (onFoot ? 6 : 9.5) && slow) {
      this.bustT += dt;
      if (this.bustT > (onFoot ? 1.5 : 2.5)) { this.bustT = 0; this.onBusted(); }
    } else this.bustT = Math.max(0, this.bustT - dt);
    if (this.heat > 0 && nearest > 95) {
      this.evade += dt;
      if (this.evade > 12) { this.evade = 0; this.heat--; this.onHeat(this.heat); }
    } else if (nearest < 60) this.evade = 0;
    return { nearest, nearestPos: nearestUnit?.pos ?? null, bustProgress: this.bustT / (onFoot ? 1.5 : 2.5) };
  }
}
