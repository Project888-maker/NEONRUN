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
  update(dt: number, target: THREE.Vector3, targetVel: THREE.Vector3, t: number) {
    const aim = target.clone().addScaledVector(targetVel, 0.6).add(new THREE.Vector3(0, 2.4 + Math.sin(t * 2) * 0.4, 0));
    const to = aim.sub(this.mesh.position);
    const desired = to.clone().normalize().multiplyScalar(Math.min(44, to.length() * 1.6));
    this.vel.lerp(desired, Math.min(1, dt * 1.6));
    this.mesh.position.addScaledVector(this.vel, dt);
    if (this.mesh.position.y < 1.2) this.mesh.position.y = 1.2;
    this.mesh.lookAt(target.x, this.mesh.position.y, target.z);
    this.mesh.rotateX(Math.min(0.4, this.vel.length() * 0.012));
    for (const r of this.rotors) r.rotation.y += dt * 60;
    (this.light.material as THREE.MeshBasicMaterial).color.setRGB(Math.sin(t * 12) > 0 ? 8 : 0.5, 0.2, 0.1);
    this.cooldown -= dt;
  }
}
