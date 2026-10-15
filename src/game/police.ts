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

/** Wanted level + pursuing police cruisers. */
export class Police {
  group = new THREE.Group();
  heat = 0;
  units: Unit[] = [];
  light: THREE.PointLight;
  private evade = 0;
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
  }

  private removeUnit(u: Unit) {
    u.root.removeFromParent();
    this.phys.world.removeRigidBody(u.body);
  }

  private makeUnit(pos: THREE.Vector3, yaw: number): Unit | null {
    if (!this.asset) return null;
    const sp = this.asset.spec;
    const root = new THREE.Group();
    for (const b of this.asset.body) {
      let mat = b.material;
      if ((mat as THREE.MeshStandardMaterial).map) { const pm = carPaint(mat as THREE.MeshStandardMaterial, this.envMap); patchCarLights(pm, sp.length / 2, false); mat = pm; }
      root.add(new THREE.Mesh(b.geometry, mat));
    }
    const wheels: THREE.Object3D[] = [];
    for (const k of ['FL', 'FR', 'RL', 'RR'] as const) {
      const piv = new THREE.Group();
      piv.position.set(...sp.wheels[k]);
      for (const w of this.asset.wheels[k]) piv.add(new THREE.Mesh(w.geometry, w.material));
      root.add(piv);
      wheels.push(piv);
    }
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
      }
      let target = player.clone().addScaledVector(playerVel, 0.6);
      if (d > 38) {
        while (u.route.length && u.route[0].distanceTo(u.pos) < 8) u.route.shift();
        if (u.route.length) target = u.route[0];
      }
      const to = target.clone().sub(u.pos).setY(0);
      const dist = to.length();
      const desiredYaw = Math.atan2(to.x, to.z);
      let dy = desiredYaw - u.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      u.yaw += THREE.MathUtils.clamp(dy, -dt * 2.4, dt * 2.4);
      const maxV = d < 12 ? Math.max(4, playerVel.length() + 3) : 31;
      const corner = Math.max(0.35, 1 - Math.abs(dy) * 0.9);
      u.speed = THREE.MathUtils.lerp(u.speed, Math.min(maxV, dist * 2) * corner, Math.min(1, dt * 1.6));
      u.pos.addScaledVector(new THREE.Vector3(Math.sin(u.yaw), 0, Math.cos(u.yaw)), u.speed * dt);
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
    // shared flashing light at the nearest cruiser
    if (nearestUnit) {
      this.light.position.copy(nearestUnit.pos).add(new THREE.Vector3(0, 2.5, 0));
      const ph = Math.floor(t * 6) % 2;
      this.light.color.set(ph ? 0xff1020 : 0x2050ff);
      this.light.intensity = 120;
    } else this.light.intensity = 0;

    // busted / evade
    const slow = playerVel.length() < (onFoot ? 99 : 3);
    if (this.heat > 0 && nearest < (onFoot ? 5 : 8) && slow) {
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
