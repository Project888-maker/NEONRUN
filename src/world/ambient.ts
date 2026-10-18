import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { kitParts } from '../core/assets';
import { HALF, RAIL_Z } from './layout';
import { LAYER_NO_REFLECT } from '../render/reflector';

/** Elevated metro train running along the rail line. */
export class Train {
  group = new THREE.Group();
  x = -HALF - 150;
  dir = 1;
  speed = 26;
  readonly cars = 4;
  readonly carLen = 18.6;
  constructor(kit: GLTF) {
    const parts = kitParts(kit, 'train_car');
    for (let i = 0; i < this.cars; i++) {
      const g = new THREE.Group();
      for (const p of parts) {
        const mat = p.material as THREE.MeshStandardMaterial;
        if (mat.name.startsWith('emit_')) mat.emissiveIntensity = 5;
        g.add(new THREE.Mesh(p.geometry, mat));
      }
      g.rotation.y = Math.PI / 2;
      g.position.set(0, 14.05, RAIL_Z + (i % 2 ? 1.3 : -1.3) * 0);
      this.group.add(g);
    }
  }
  get position() { return new THREE.Vector3(this.x, 15, RAIL_Z); }
  update(dt: number) {
    this.x += this.dir * this.speed * dt;
    if (this.x > HALF + 250) { this.dir = -1; }
    if (this.x < -HALF - 250) { this.dir = 1; }
    this.group.children.forEach((c, i) => {
      c.position.x = this.x - this.dir * i * this.carLen;
      c.position.z = RAIL_Z + (this.dir > 0 ? -1.2 : 1.2);
    });
  }
}

/** Distant flying vehicle traffic: blinking light points on sky lanes (fully GPU). */
export class SkyTraffic {
  points: THREE.Points;
  constructor(count = 400) {
    const lane = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      lane.set([Math.random() * Math.PI * 2, 60 + Math.random() * 160, Math.random(), (Math.random() - 0.5) * 2], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aLane', new THREE.BufferAttribute(lane, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uTime; attribute vec4 aLane; varying vec3 vC;
        void main(){
          float ang = aLane.x; float h = aLane.y; float seed = aLane.z;
          vec2 dir = vec2(cos(ang), sin(ang));
          vec2 perp = vec2(-dir.y, dir.x);
          float along = mod(seed * 3000.0 + uTime * (25.0 + seed * 30.0) * sign(aLane.w + 0.001), 3000.0) - 1500.0;
          vec3 p = vec3(dir * along + perp * aLane.w * 900.0, h).xzy;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float blink = step(0.8, fract(uTime * (0.7 + seed) + seed * 7.0));
          vC = mix(vec3(1.0, 0.85, 0.7) * 2.0, vec3(3.0, 0.2, 0.15), step(0.5, fract(seed * 13.0))) * (0.5 + blink);
          gl_PointSize = clamp(900.0 / -mv.z, 1.5, 6.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vC * (1.0 - smoothstep(0.1, 0.5, d)), 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_NO_REFLECT);
  }
  update(t: number, cam: THREE.Vector3) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    this.points.position.set(cam.x * 0.0, 0, cam.z * 0.0);
  }
}

/** Hazard drone (mission enemy): procedural quadcopter that chases the player. */
const _g = new THREE.Vector3(), _h = new THREE.Vector3();

export class Drone {
  mesh = new THREE.Group();
  vel = new THREE.Vector3();
  light: THREE.Mesh;
  private rotors: THREE.Mesh[] = [];
  cooldown = 0;
  constructor() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x15161a, metalness: 0.8, roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.9), dark);
    this.mesh.add(body);
    for (const [x, z] of [[0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 1.0), dark);
      arm.position.set(x / 2, 0, z / 2);
      arm.lookAt(new THREE.Vector3(x, 0, z).multiplyScalar(2));
      this.mesh.add(arm);
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.02, 16), new THREE.MeshBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.25 }));
      rotor.position.set(x, 0.14, z);
      this.mesh.add(rotor);
      this.rotors.push(rotor);
    }
    this.light = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.2, 0.1) }));
    this.light.position.y = -0.18;
    this.mesh.add(this.light);
    const eye = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.3, 0.2) }));
    eye.position.set(0, 0, 0.46);
    this.mesh.add(eye);
  }
  /**
   * Security drone behaviour. Patrols its post, chases a target it spots, but it is slower than a
   * car at speed and gives up when outrun; it only strikes after holding a lock for a moment, then
   * backs off. Returns true on the frame it strikes.
   */
  update(dt: number, target: THREE.Vector3, targetVel: THREE.Vector3, t: number): boolean {
    const p = this.mesh.position;
    if (!this.homeSet) { this.home.copy(p); this.homeSet = true; this.phase = Math.random() * 6.28; }
    const flat = Math.hypot(target.x - p.x, target.z - p.z);
    this.stateT += dt;
    this.cooldown -= dt;
    let goal: THREE.Vector3, speed: number, struck = false;
    switch (this.state) {
      case 'patrol': {
        const a = this.phase + t * 0.25;
        goal = _g.set(this.home.x + Math.cos(a) * 22, this.home.y + Math.sin(t * 0.7) * 1.5, this.home.z + Math.sin(a) * 22);
        speed = 8;
        if (flat < Drone.SPOT && this.cooldown <= 0) this.set('chase');
        break;
      }
      case 'chase': {
        goal = _g.copy(target).addScaledVector(targetVel, 0.35); goal.y += 3.2 + Math.sin(t * 2) * 0.3;
        speed = Drone.MAX_SPEED;
        // lock-on builds only while the target stays close; moving fast keeps breaking it
        const d = p.distanceTo(_h.copy(target).setY(target.y + 1));
        this.lock = d < 8 ? this.lock + dt : Math.max(0, this.lock - dt * 2);
        if (this.lock >= Drone.LOCK_TIME) { struck = true; this.lock = 0; this.set('retreat'); this.vel.multiplyScalar(-0.6).add(_h.set(0, 10, 0)); }
        this.lost = flat > Drone.GIVE_UP ? this.lost + dt : 0;
        if (this.lost > 3) { this.set('return'); this.cooldown = 5; }
        break;
      }
      case 'retreat': {
        // climb and drift away, then decide again
        goal = _g.copy(p).sub(target).setY(0).normalize().multiplyScalar(30).add(p); goal.y = this.home.y;
        speed = 12;
        if (this.stateT > 6) this.set(flat < Drone.SPOT ? 'chase' : 'return');
        break;
      }
      default: { // return to post
        goal = _g.copy(this.home);
        speed = 14;
        if (p.distanceTo(this.home) < 6) this.set('patrol');
        if (flat < Drone.SPOT * 0.6 && this.cooldown <= 0) this.set('chase');
      }
    }
    const gd = goal.distanceTo(p);
    const desired = _h.copy(goal).sub(p).normalize().multiplyScalar(Math.min(speed, gd * 1.4));
    this.vel.lerp(desired, Math.min(1, dt * 1.4));
    p.addScaledVector(this.vel, dt);
    if (p.y < 2.2) p.y = 2.2;
    if (this.state === 'chase') this.mesh.lookAt(target.x, p.y, target.z);
    else if (this.vel.lengthSq() > 1) this.mesh.lookAt(p.x + this.vel.x, p.y, p.z + this.vel.z);
    this.mesh.rotateX(Math.min(0.35, this.vel.length() * 0.015));
    for (const r of this.rotors) r.rotation.y += dt * 60;
    // red light: slow blink on patrol, fast while chasing, solid while locking on
    const locking = this.state === 'chase' && this.lock > 0.05;
    const blink = this.state === 'patrol' || this.state === 'return' ? Math.sin(t * 3) > 0.6 : locking || Math.sin(t * 12) > 0;
    (this.light.material as THREE.MeshBasicMaterial).color.setRGB(blink ? 8 : 0.5, 0.2, 0.1);
    // targeting laser while locking on, so the player can see the strike coming
    this.beam.visible = locking;
    if (locking) {
      const end = _h.copy(target).setY(target.y + 0.8);
      const len = p.distanceTo(end);
      this.beam.position.copy(p).lerp(end, 0.5);
      this.beam.lookAt(end);
      this.beam.scale.set(1, 1, len);
      (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.6 * (this.lock / Drone.LOCK_TIME);
      if (this.mesh.parent && this.beam.parent !== this.mesh.parent) this.mesh.parent.add(this.beam);
    }
    return struck;
  }
  static SPOT = 60; // m: notices the target
  static GIVE_UP = 110; // m: loses interest after 3 s this far behind
  static MAX_SPEED = 19; // m/s (~68 km/h): a car at speed can outrun it, a runner cannot
  static LOCK_TIME = 0.8; // s within 8 m before it strikes
  state: 'patrol' | 'chase' | 'retreat' | 'return' = 'patrol';
  home = new THREE.Vector3();
  lock = 0;
  private homeSet = false;
  private phase = 0;
  private stateT = 0;
  private lost = 0;
  private set(s: Drone['state']) { this.state = s; this.stateT = 0; this.lost = 0; if (s !== 'chase') this.lock = 0; }
  beam = (() => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.3, 0.2), transparent: true, opacity: 0.5, depthWrite: false }));
    m.visible = false;
    return m;
  })();
  dispose() { this.mesh.removeFromParent(); this.beam.removeFromParent(); }
}
