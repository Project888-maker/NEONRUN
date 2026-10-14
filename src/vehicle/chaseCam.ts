import * as THREE from 'three';
import type { Physics } from '../core/physics';
import { RAPIER, groups, GROUP_CAR, GROUP_WORLD } from '../core/physics';

/** Smooth third-person chase camera with speed FOV, shake and wall avoidance. */
export class ChaseCam {
  shake = 0;
  mode: 'chase' | 'far' | 'hood' = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0;
  private t = 0;
  private init = false;

  constructor(public cam: THREE.PerspectiveCamera, private phys: Physics) {}

  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, carVel: THREE.Vector3, speed: number, boosting: boolean, drifting: boolean, exclude: RAPIER.RigidBody) {
    this.t += dt;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    fwd.y = 0;
    fwd.normalize();
    // follow the direction of travel a little when sliding (classic drift cam)
    const velDir = carVel.clone().setY(0);
    const blend = velDir.length() > 6 ? (drifting ? 0.45 : 0.15) : 0;
    if (velDir.lengthSq() > 1) velDir.normalize();
    const dirTarget = fwd.clone().lerp(velDir, blend).normalize();
    const targetYaw = Math.atan2(dirTarget.x, dirTarget.z);
    if (!this.init) this.yaw = targetYaw;
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * (drifting ? 3.2 : 5.5));
    const dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    const s = Math.min(1, Math.abs(speed) / 60);
    const dist = this.mode === 'far' ? 9 + s * 3 : this.mode === 'hood' ? -0.6 : 5.6 + s * 2.2 + (boosting ? 0.8 : 0);
    const height = this.mode === 'far' ? 3.6 : this.mode === 'hood' ? 1.25 : 1.85 + s * 0.3;
    const desired = carPos.clone().addScaledVector(dir, -dist).add(new THREE.Vector3(0, height, 0));
    // wall avoidance: ray from car roof to desired camera position
    if (this.mode !== 'hood') {
      const origin = carPos.clone().add(new THREE.Vector3(0, 1.5, 0));
      const to = desired.clone().sub(origin);
      const len = to.length();
      to.normalize();
      const hit = this.phys.world.castRay(new RAPIER.Ray(origin, to), len, true, undefined, groups(GROUP_CAR, GROUP_WORLD), undefined, exclude);
      if (hit) desired.copy(origin).addScaledVector(to, Math.max(1.2, hit.timeOfImpact - 0.4));
    }
    if (!this.init) { this.pos.copy(desired); this.init = true; }
    // critically damped spring
    const k = this.mode === 'hood' ? 400 : 60, c = 2 * Math.sqrt(k);
    const acc = desired.clone().sub(this.pos).multiplyScalar(k).addScaledVector(this.vel, -c);
    this.vel.addScaledVector(acc, Math.min(dt, 1 / 30));
    this.pos.addScaledVector(this.vel, Math.min(dt, 1 / 30));
    if (this.mode === 'hood') this.pos.copy(desired);
    if (this.pos.y < 0.4) this.pos.y = 0.4;

    const lookTarget = carPos.clone().addScaledVector(dir, this.mode === 'hood' ? 20 : 3.5).add(new THREE.Vector3(0, this.mode === 'hood' ? 1.0 : 0.9, 0));
    this.look.lerp(lookTarget, this.init ? Math.min(1, dt * 12) : 1);

    // shake: impacts + high speed rumble
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sh = this.shake * this.shake + s * s * 0.012 + (boosting ? 0.02 : 0);
    const n = (f: number, o: number) => Math.sin(this.t * f + o) * 0.5 + Math.sin(this.t * f * 2.3 + o * 1.7) * 0.5;
    const off = new THREE.Vector3(n(23, 0), n(29, 3), n(19, 7)).multiplyScalar(sh * 0.6);
    this.cam.position.copy(this.pos).add(off);
    this.cam.lookAt(this.look);
    // roll slightly into drifts
    this.cam.rotateZ(THREE.MathUtils.clamp(-dy * 0.4, -0.06, 0.06));

    const fov = 62 + s * 18 + (boosting ? 10 : 0);
    this.cam.fov = THREE.MathUtils.lerp(this.cam.fov, fov, Math.min(1, dt * 3));
    this.cam.updateProjectionMatrix();
  }

  impact(strength: number) { this.shake = Math.min(1.2, this.shake + strength); }
}
