import * as THREE from 'three';
import { RAPIER, GROUP_CAR, groups, GROUP_WORLD, GROUP_TRAFFIC, GROUP_GATE } from '../core/physics';
import type { Physics } from '../core/physics';

/**
 * Raycast vehicle on a Rapier rigid body.
 * Car frame: forward +Z, up +Y, left +X.
 * Tire model: simplified Pacejka lateral curve + friction circle, RWD for power oversteer,
 * handbrake drops rear grip for drifting, arcade assists keep it controllable.
 */

export interface VehicleInput { throttle: number; brake: number; steer: number; handbrake: boolean; boost: boolean }

export interface VehicleOpts {
  mass?: number; wheelRadius?: number; power?: number; topSpeed?: number; grip?: number;
  dims?: { length: number; width: number; height: number };
}

export interface Upgrades { speed: number; grip: number; boost: number } // levels 0..3

interface Wheel {
  local: THREE.Vector3; // suspension top attachment in body space
  front: boolean;
  left: boolean;
  compression: number;
  prevCompression: number;
  contact: boolean;
  contactPoint: THREE.Vector3;
  normal: THREE.Vector3;
  spin: number; // rad
  spinVel: number;
  steer: number;
  slipLat: number;
  slipLong: number;
  load: number;
  surfaceY: number;
}

const V = () => new THREE.Vector3();

export class Vehicle {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  wheels: Wheel[] = [];
  mass = 1450;
  wheelRadius = 0.37;
  readonly restLength = 0.38;
  stiffness = 46000;
  damping = 4600;
  /** per-car tuning (1 = hero car baseline) */
  power = 1; topSpeed = 56; grip = 1;
  private get ik() { return this.mass / 1450; } // inertia scale for torque-based assists

  // state for gameplay/audio/visuals
  speed = 0; // m/s along forward
  speedAbs = 0;
  rpm = 900;
  gear = 1;
  steerAngle = 0;
  boost = 1; // 0..1 tank
  boosting = false;
  drifting = false;
  driftAngle = 0;
  driftTime = 0;
  airborne = false;
  braking = false;
  onShift: (gear: number) => void = () => {};
  upgrades: Upgrades = { speed: 0, grip: 0, boost: 0 };

  private q = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private fwd = V(); private up = V(); private left = V();
  private tmp1 = V(); private tmp2 = V(); private tmp3 = V();

  constructor(private phys: Physics, start: THREE.Vector3, yaw: number, wheelPos?: Record<string, THREE.Vector3>, opts: VehicleOpts = {}) {
    const w = phys.world;
    if (opts.mass) this.mass = opts.mass;
    if (opts.wheelRadius) this.wheelRadius = opts.wheelRadius;
    this.power = opts.power ?? 1; this.topSpeed = opts.topSpeed ?? 56; this.grip = opts.grip ?? 1;
    this.stiffness = this.mass * 31.7;
    this.damping = this.mass * 3.17;
    const dims = opts.dims ?? { length: 4.8, width: 2.0, height: 1.3 };
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(start.x, start.y, start.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setLinearDamping(0.02)
      .setAngularDamping(0.9);
    this.body = w.createRigidBody(desc);
    const cd = RAPIER.ColliderDesc.cuboid(dims.width * 0.45, dims.height * 0.28, dims.length * 0.478)
      .setTranslation(0, Math.max(0.6, dims.height * 0.6), 0.05)
      .setDensity(0)
      .setFriction(0.15)
      .setRestitution(0.15)
      .setCollisionGroups(groups(GROUP_CAR, GROUP_WORLD | GROUP_TRAFFIC | GROUP_GATE))
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(6000);
    this.collider = w.createCollider(cd, this.body);
    // second, lower-front collider for the nose / cabin shape
    w.createCollider(RAPIER.ColliderDesc.cuboid(dims.width * 0.36, dims.height * 0.18, dims.length * 0.23).setTranslation(0, dims.height * 0.92, -0.2).setDensity(0).setFriction(0.15)
      .setCollisionGroups(groups(GROUP_CAR, GROUP_WORLD | GROUP_TRAFFIC | GROUP_GATE)), this.body);
    const m = this.mass;
    const k = m / 1450;
    this.body.setAdditionalMassProperties(m, { x: 0, y: Math.min(0.62, dims.height * 0.37), z: 0.05 }, { x: 3600 * k, y: 3900 * k, z: 900 * k }, { x: 0, y: 0, z: 0, w: 1 }, true);

    const def: Record<string, THREE.Vector3> = wheelPos ?? {
      FL: new THREE.Vector3(0.84, 0.35, 1.43), FR: new THREE.Vector3(-0.84, 0.35, 1.43),
      RL: new THREE.Vector3(0.84, 0.35, -1.38), RR: new THREE.Vector3(-0.84, 0.35, -1.38),
    };
    for (const k of ['FL', 'FR', 'RL', 'RR']) {
      const p = def[k];
      this.wheels.push({
        // attachment: wheel centre raised by the rest length so the ray starts above the wheel
        local: new THREE.Vector3(p.x, p.y + this.restLength * 0.6, p.z), front: k[0] === 'F', left: k[1] === 'L',
        compression: 0, prevCompression: 0, contact: false, contactPoint: V(), normal: new THREE.Vector3(0, 1, 0),
        spin: 0, spinVel: 0, steer: 0, slipLat: 0, slipLong: 0, load: 0, surfaceY: 0,
      });
    }
  }

  get maxSpeed() { return this.topSpeed + this.upgrades.speed * 5.5; }
  get engineForce() { return (this.mass * 7.93 * this.power) + this.upgrades.speed * 1600 * (this.mass / 1450); }
  get gripMul() { return this.grip * (1.0 + this.upgrades.grip * 0.09); }

  /** Remove the rigid body (switching cars / leaving a stolen car). */
  dispose() { this.phys.world.removeRigidBody(this.body); }
  get boostCap() { return 1 + this.upgrades.boost * 0.35; }

  reset(p: THREE.Vector3, yaw: number) {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  getTransform(pos: THREE.Vector3, quat: THREE.Quaternion) {
    const t = this.body.translation(), r = this.body.rotation();
    pos.set(t.x, t.y, t.z);
    quat.set(r.x, r.y, r.z, r.w);
  }

  /** Fixed-step update (call before world.step). */
  step(dt: number, inp: VehicleInput) {
    const b = this.body;
    const t = b.translation(), r = b.rotation();
    this.pos.set(t.x, t.y, t.z);
    this.q.set(r.x, r.y, r.z, r.w);
    const fwd = this.fwd.set(0, 0, 1).applyQuaternion(this.q);
    const up = this.up.set(0, 1, 0).applyQuaternion(this.q);
    const left = this.left.set(1, 0, 0).applyQuaternion(this.q);
    const lv = b.linvel(), av = b.angvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    const ang = new THREE.Vector3(av.x, av.y, av.z);
    const com = b.worldCom();
    const comV = new THREE.Vector3(com.x, com.y, com.z);

    this.speed = vel.dot(fwd);
    this.speedAbs = vel.length();
    const spd = Math.abs(this.speed);

    // ---- steering (speed sensitive, smoothed, with counter-steer assist while sliding)
    const latV = vel.dot(left);
    const slideAngle = spd > 3 ? Math.atan2(latV, Math.max(spd, 1)) : 0;
    const maxSteer = THREE.MathUtils.lerp(0.6, 0.16, Math.min(1, spd / 50));
    let target = -inp.steer * maxSteer; // positive steer input = right = -X
    if (this.drifting && !inp.handbrake) target += THREE.MathUtils.clamp(slideAngle * 0.55, -0.35, 0.35);
    const rate = Math.abs(target) > Math.abs(this.steerAngle) ? 4.5 : 7.5;
    this.steerAngle += THREE.MathUtils.clamp(target - this.steerAngle, -rate * dt, rate * dt);

    // ---- boost
    this.boosting = inp.boost && this.boost > 0.01 && inp.throttle > 0.1;
    if (this.boosting) this.boost = Math.max(0, this.boost - dt / (3.2 * this.boostCap));
    else this.boost = Math.min(1, this.boost + dt * (this.drifting ? 0.12 : 0.025));

    // ---- engine / brake demand
    const vmax = this.maxSpeed * (this.boosting ? 1.22 : 1);
    let drive = 0;
    const reversing = inp.brake > 0.1 && this.speed < 1.5 && inp.throttle < 0.1;
    if (inp.throttle > 0) {
      const ratio = Math.max(0, this.speed) / vmax;
      drive = inp.throttle * this.engineForce * Math.max(0, 1 - ratio * ratio) * (this.boosting ? 1.65 : 1);
    } else if (reversing) {
      drive = -inp.brake * 6000 * Math.max(0, 1 - Math.max(0, -this.speed) / 14);
    }
    const brakeForce = !reversing && inp.brake > 0 && this.speed > -1 ? inp.brake * 16000 : 0;
    this.braking = brakeForce > 0 || (inp.handbrake && spd > 1);

    // ---- wheels
    let grounded = 0;
    const mu = 1.55 * this.gripMul;
    const wheelMass = this.mass / 4;
    for (const w of this.wheels) {
      w.steer = w.front ? this.steerAngle : 0;
      const anchor = this.tmp1.copy(w.local).applyQuaternion(this.q).add(this.pos);
      const down = this.tmp2.copy(up).negate();
      const maxLen = this.restLength + this.wheelRadius;
      const ray = new RAPIER.Ray({ x: anchor.x, y: anchor.y, z: anchor.z }, { x: down.x, y: down.y, z: down.z });
      const hit = this.phys.world.castRayAndGetNormal(ray, maxLen, true, undefined, groups(GROUP_CAR, GROUP_WORLD | GROUP_TRAFFIC), undefined, b);
      w.prevCompression = w.compression;
      if (!hit) {
        w.contact = false;
        w.compression = 0;
        w.load = 0;
        // free wheel spin decays / follows throttle
        w.spinVel = THREE.MathUtils.lerp(w.spinVel, w.front ? w.spinVel : (inp.throttle * 60), dt * 2);
        w.spin += w.spinVel * dt;
        continue;
      }
      grounded++;
      w.contact = true;
      const toi = hit.timeOfImpact;
      w.compression = maxLen - toi;
      w.contactPoint.copy(anchor).addScaledVector(down, toi);
      w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      w.surfaceY = w.contactPoint.y;

      // suspension
      const compVel = (w.compression - w.prevCompression) / dt;
      let fs = this.stiffness * w.compression + this.damping * compVel;
      fs = Math.max(0, Math.min(fs, 60000));
      w.load = fs;
      const susImp = this.tmp3.copy(up).multiplyScalar(fs * dt);
      b.applyImpulseAtPoint({ x: susImp.x, y: susImp.y, z: susImp.z }, { x: anchor.x, y: anchor.y, z: anchor.z }, true);

      // tire frame
      const wf = new THREE.Vector3().copy(fwd).applyAxisAngle(up, w.steer);
      const n = w.normal;
      wf.addScaledVector(n, -wf.dot(n)).normalize();
      const ws = new THREE.Vector3().crossVectors(n, wf).normalize(); // points left
      const rp = new THREE.Vector3().copy(w.contactPoint).sub(comV);
      const pv = new THREE.Vector3().crossVectors(ang, rp).add(vel);
      const vLong = pv.dot(wf);
      const vLat = pv.dot(ws);
      const Fz = Math.max(fs, 0);

      // grip: rear loses grip on handbrake; slight load sensitivity
      let gripW = mu * (1 - Math.min(0.25, Fz / 40000));
      if (!w.front && inp.handbrake) gripW *= 0.42;
      if (!w.front && this.boosting) gripW *= 0.93;
      const maxF = gripW * Fz;

      // lateral (slip-angle based, magic-formula-ish)
      const alpha = Math.atan2(vLat, Math.max(Math.abs(vLong), 3.5));
      w.slipLat = alpha;
      const B = w.front ? 9 : 8;
      let Fy = -Math.sin(1.55 * Math.atan(B * alpha)) * maxF;
      if (spd < 4) {
        // low-speed: kill lateral creep directly
        const fLow = -vLat * wheelMass / dt * 0.25;
        Fy = THREE.MathUtils.lerp(fLow, Fy, spd / 4);
        Fy = THREE.MathUtils.clamp(Fy, -maxF, maxF);
      }

      // longitudinal
      let Fx = 0;
      if (!w.front) Fx += drive / 2;
      // ABS: brake force per wheel never exceeds ~85% of available grip
      if (brakeForce > 0) Fx -= Math.sign(vLong) * Math.min(brakeForce * (w.front ? 0.34 : 0.16), maxF * 0.85);
      if (!w.front && inp.handbrake) Fx -= Math.sign(vLong) * Math.min(Math.abs(vLong) * wheelMass / dt * 0.2, maxF * 0.3);
      Fx -= vLong * 18; // rolling resistance
      // friction circle (rear drive wheels can spin up -> power oversteer)
      const tot = Math.hypot(Fx, Fy);
      let slipRatio = 0;
      if (tot > maxF) {
        slipRatio = tot / maxF - 1;
        const k = maxF / tot;
        Fx *= k;
        // lateral is hit harder than longitudinal when the wheel is saturated (wheelspin / lockup)
        // only driven-wheel spin (power oversteer) eats extra lateral grip
        const powerSpin = !w.front && drive > 0 && !inp.handbrake;
        Fy *= k * (powerSpin ? Math.max(0.55, 1 - slipRatio * 0.6) : 1);
      }
      w.slipLong = slipRatio;
      const imp = new THREE.Vector3().addScaledVector(wf, Fx * dt).addScaledVector(ws, Fy * dt);
      b.applyImpulseAtPoint({ x: imp.x, y: imp.y, z: imp.z }, { x: w.contactPoint.x, y: w.contactPoint.y + 0.25, z: w.contactPoint.z }, true);

      // visual wheel spin
      const target = vLong / this.wheelRadius + (!w.front && inp.throttle > 0.5 && slipRatio > 0.2 ? 25 * inp.throttle : 0);
      w.spinVel = !w.front && inp.handbrake ? 0 : target;
      w.spin += w.spinVel * dt;
    }

    this.airborne = grounded === 0;
    // ---- aero: downforce + drag
    const v2 = this.speedAbs * this.speedAbs;
    if (grounded > 0) {
      const df = up.clone().multiplyScalar(-v2 * 2.4 * dt);
      b.applyImpulse({ x: df.x, y: df.y, z: df.z }, true);
    }
    const drag = vel.clone().multiplyScalar(-this.speedAbs * 0.42 * dt);
    b.applyImpulse({ x: drag.x, y: drag.y, z: drag.z }, true);

    // ---- assists
    const yawRate = ang.dot(up);
    if (grounded >= 2) {
      // drift detection
      const rearSlip = Math.abs((this.wheels[2].slipLat + this.wheels[3].slipLat) / 2);
      const wasDrifting = this.drifting;
      this.drifting = spd > 9 && (rearSlip > 0.2 || (inp.handbrake && Math.abs(yawRate) > 0.5));
      this.driftAngle = slideAngle;
      this.driftTime = this.drifting ? this.driftTime + dt : wasDrifting ? this.driftTime : 0;
      // steering helps rotate while drifting (arcade), and caps spin-outs
      if (this.drifting) {
        const yawAssist = -inp.steer * 2600 * this.ik * Math.min(1, spd / 20) * Math.max(0, 1 - Math.abs(slideAngle) / 0.8);
        b.applyTorqueImpulse({ x: up.x * yawAssist * dt, y: up.y * yawAssist * dt, z: up.z * yawAssist * dt }, true);
      }
      // stability control: damp unintended slides (not while the player is handbraking)
      if (!inp.handbrake && Math.abs(slideAngle) > 0.28 && spd > 8) {
        const intent = Math.sign(-inp.steer) === Math.sign(yawRate) ? 0.4 : 1; // steering into the rotation = drifting on purpose
        const corr = -yawRate * 1900 * this.ik * Math.min(1, (Math.abs(slideAngle) - 0.28) * 3) * intent;
        b.applyTorqueImpulse({ x: up.x * corr * dt, y: up.y * corr * dt, z: up.z * corr * dt }, true);
      }
      // drift angle limiter + speed keeper: big, holdable arcade drifts that don't spin out
      if (Math.abs(slideAngle) > 0.3 && spd > 6) {
        const over = Math.abs(slideAngle) - 0.55;
        if (over > 0 && Math.sign(yawRate) === Math.sign(-slideAngle)) {
          const corr = -yawRate * this.ik * (9000 * Math.min(1, over * 4) + (Math.abs(slideAngle) > 1.0 ? 14000 : 0));
          b.applyTorqueImpulse({ x: up.x * corr * dt, y: up.y * corr * dt, z: up.z * corr * dt }, true);
        }
        if (inp.throttle > 0) {
          const vdir = vel.clone().setY(0).normalize();
          const keep = vdir.multiplyScalar(this.mass * 4.2 * inp.throttle * Math.min(1, Math.abs(slideAngle) * 2) * dt);
          b.applyImpulse({ x: keep.x, y: 0, z: keep.z }, true);
        }
      }
      const maxYaw = 2.6;
      if (Math.abs(yawRate) > maxYaw) {
        const corr = -(yawRate - Math.sign(yawRate) * maxYaw) * 3600 * this.ik;
        b.applyTorqueImpulse({ x: up.x * corr * dt, y: up.y * corr * dt, z: up.z * corr * dt }, true);
      }
      // anti-flip: keep the car upright while on the ground
      const tilt = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
      b.applyTorqueImpulse({ x: tilt.x * 9000 * this.ik * dt, y: 0, z: tilt.z * 9000 * this.ik * dt }, true);
    } else {
      // in the air: gently level out
      const tilt = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
      b.applyTorqueImpulse({ x: tilt.x * 4000 * this.ik * dt, y: 0, z: tilt.z * 4000 * this.ik * dt }, true);
      this.drifting = false;
    }

    // ---- gearbox (for audio)
    const gears = [0, 9, 17, 26, 36, 47, 99];
    let g = 1;
    while (g < 6 && spd > gears[g]) g++;
    if (g !== this.gear) { this.gear = g; this.onShift(g); }
    const lo = gears[g - 1], hi = gears[g];
    const frac = THREE.MathUtils.clamp((spd - lo) / (hi - lo), 0, 1);
    const wheelspin = (this.wheels[2].slipLong + this.wheels[3].slipLong) * 0.5;
    const targetRpm = 1100 + frac * 5600 + (g === 1 ? 0 : 900) + Math.min(1500, wheelspin * 2500) + (this.airborne ? inp.throttle * 2500 : 0);
    this.rpm = THREE.MathUtils.lerp(this.rpm, inp.throttle > 0.05 || spd > 1 ? targetRpm : 900, Math.min(1, dt * 8));
  }

  /** Flip the car back onto its wheels if it is stuck upside-down or on its side. */
  isUpsideDown() {
    const r = this.body.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return up.y < 0.3;
  }
  yaw() {
    const r = this.body.rotation();
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return Math.atan2(f.x, f.z);
  }
}
