import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Physics } from '../core/physics';
import { RAPIER, groups, GROUP_CAR, GROUP_WORLD, GROUP_TRAFFIC } from '../core/physics';
import { Person, lerpAngle } from '../world/people';

export interface FootInput { x: number; z: number; run: boolean; jump: boolean }

/**
 * The courier on foot: a Rapier kinematic character controller (capsule) driving the rigged hero.
 * Movement is camera-relative; animations: idle / walk / run / jump.
 */
export class HeroOnFoot {
  person: Person;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  kcc: RAPIER.KinematicCharacterController;
  vy = 0;
  grounded = true;
  speed = 0;
  busy = 0; // seconds of a scripted animation (enter car, talk) during which input is ignored
  active = false;
  private stepT = 0;
  onStep: () => void = () => {};
  onJump: () => void = () => {};
  onLand: () => void = () => {};

  constructor(private phys: Physics, gltf: GLTF) {
    this.person = new Person(gltf, 'hero');
    this.person.root.visible = false;
    const w = phys.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.3).setTranslation(0, 0.85, 0)
      .setCollisionGroups(groups(GROUP_CAR, GROUP_WORLD | GROUP_TRAFFIC)), this.body);
    this.kcc = w.createCharacterController(0.03);
    this.kcc.enableAutostep(0.35, 0.15, true);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(80);
  }

  get pos() { const t = this.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); }

  spawn(p: THREE.Vector3, yaw: number) {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
    this.person.place(p.x, p.y, p.z, yaw);
    this.person.root.visible = true;
    this.active = true;
    this.vy = 0;
  }

  hide() {
    this.active = false;
    this.person.root.visible = false;
    this.body.setTranslation({ x: 0, y: -50, z: 0 }, true);
  }

  update(dt: number, inp: FootInput, camYaw: number) {
    if (!this.active) return;
    const t = this.body.translation();
    let move = new THREE.Vector3();
    const busy = this.busy > 0;
    this.busy = Math.max(0, this.busy - dt);
    if (!busy) {
      // camera-relative input: forward = away from camera
      const fwd = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      move.addScaledVector(fwd, inp.z).addScaledVector(right, inp.x);
      if (move.lengthSq() > 1) move.normalize();
    }
    const target = move.length() * (inp.run ? 6.2 : 2.1);
    this.speed = THREE.MathUtils.lerp(this.speed, target, Math.min(1, dt * 8));
    if (move.lengthSq() > 0.01) this.person.yaw = lerpAngle(this.person.yaw, Math.atan2(move.x, move.z), Math.min(1, dt * 10));
    const dir = new THREE.Vector3(Math.sin(this.person.yaw), 0, Math.cos(this.person.yaw));
    // gravity + jump
    if (this.grounded && inp.jump && !busy) { this.vy = 5.2; this.grounded = false; this.person.play('jump', { loop: false, fade: 0.1, speed: 1.4 }); this.onJump(); }
    this.vy -= 18 * dt;
    const desired = dir.multiplyScalar(this.speed * dt).add(new THREE.Vector3(0, this.vy * dt, 0));
    this.kcc.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(GROUP_CAR, GROUP_WORLD | GROUP_TRAFFIC));
    const m = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    if (this.grounded && this.vy < 0) { if (!wasGrounded && this.vy < -4) this.onLand(); this.vy = 0; }
    const np = { x: t.x + m.x, y: Math.max(-0.05, t.y + m.y), z: t.z + m.z };
    this.body.setNextKinematicTranslation(np);
    this.person.place(np.x, np.y, np.z, this.person.yaw);
    // animation selection
    if (!busy) {
      if (!this.grounded) { /* jump clip keeps playing */ }
      else if (this.speed > 3.6) this.person.play('run', { speed: this.speed / 5.5 });
      else if (this.speed > 0.35) this.person.play('walk', { speed: Math.max(0.6, this.speed / 1.5) });
      else this.person.play('idle', { fade: 0.35 });
    }
    // footsteps
    if (this.grounded && this.speed > 0.5) {
      this.stepT -= dt * (this.speed > 3.6 ? 2.9 : 1.9);
      if (this.stepT <= 0) { this.stepT = 1; this.onStep(); }
    }
    this.person.update(dt);
  }
}

/** Third-person orbit camera for walking around. Mouse (pointer lock) or Q/E + arrows rotate it. */
export class FootCam {
  yaw = 0;
  pitch = 0.18;
  private pos = new THREE.Vector3();
  private init = false;
  constructor(public cam: THREE.PerspectiveCamera, private phys: Physics) {
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) { this.yaw -= e.movementX * 0.0032; this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * 0.0025, -0.35, 0.9); }
    });
  }
  reset(yaw: number) { this.yaw = yaw; this.init = false; }
  update(dt: number, target: THREE.Vector3, keys: Set<string>, exclude: RAPIER.Collider) {
    if (keys.has('KeyQ') || keys.has('ArrowLeft')) this.yaw += dt * 2.2;
    if (keys.has('KeyE') && false) this.yaw -= dt * 2.2;
    if (keys.has('ArrowRight')) this.yaw -= dt * 2.2;
    const dist = 3.4;
    const pivot = target.clone().add(new THREE.Vector3(0, 1.55, 0));
    const back = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    // over-the-shoulder offset
    const side = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw)).multiplyScalar(0.45);
    let d = dist;
    const hit = this.phys.world.castRay(new RAPIER.Ray(pivot, back), dist, true, undefined, groups(GROUP_CAR, GROUP_WORLD), exclude);
    if (hit) d = Math.max(0.6, hit.timeOfImpact - 0.25);
    const want = pivot.clone().addScaledVector(back, d).add(side);
    if (!this.init) { this.pos.copy(want); this.init = true; }
    this.pos.lerp(want, Math.min(1, dt * 12));
    this.cam.position.copy(this.pos);
    this.cam.lookAt(pivot.clone().add(side).add(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(2)));
    this.cam.fov = THREE.MathUtils.lerp(this.cam.fov, 58, Math.min(1, dt * 3));
    this.cam.updateProjectionMatrix();
  }
}
