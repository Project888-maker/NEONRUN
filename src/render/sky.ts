import * as THREE from 'three';
import { LAYER_NO_REFLECT } from './reflector';

/** Distant skyline panorama on a camera-following cylinder + cloud dome. */
export class Sky {
  group = new THREE.Group();
  private clouds: THREE.ShaderMaterial;

  constructor(pano: THREE.Texture, clouds: THREE.Texture) {
    pano.colorSpace = THREE.SRGBColorSpace;
    pano.wrapS = THREE.RepeatWrapping;
    clouds.wrapS = clouds.wrapT = THREE.RepeatWrapping;
    const R = 2600, H = 1500;
    const cyl = new THREE.CylinderGeometry(R, R, H, 64, 1, true);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: pano } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv;
        void main(){
          vec2 uv = vec2(vUv.x * 2.0, (vUv.y - 0.3) / 0.7 * 1.0);
          vec3 c = texture2D(map, vec2(uv.x, clamp(uv.y, 0.002, 0.998))).rgb;
          // fade into the haze colour toward the horizon and the top edge
          vec3 haze = vec3(0.05, 0.045, 0.1);
          float top = smoothstep(0.8, 1.0, uv.y);
          float bottom = (1.0 - smoothstep(-0.05, 0.08, uv.y));
          c = mix(c * 0.9, haze, top);
          c = mix(c, vec3(0.06, 0.04, 0.09), bottom);
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    const m = new THREE.Mesh(cyl, mat);
    m.position.y = H / 2 - 420;
    m.renderOrder = -10;
    this.group.add(m);

    this.clouds = new THREE.ShaderMaterial({
      uniforms: { map: { value: clouds }, uTime: { value: 0 } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D map; uniform float uTime; varying vec3 vP;
        void main(){
          vec3 d = normalize(vP);
          float el = d.y;
          vec2 uv = d.xz / max(el, 0.08) * 0.35 + vec2(uTime * 0.004, uTime * 0.0015);
          vec3 cl = texture2D(map, uv).rgb;
          vec3 base = mix(vec3(0.07, 0.05, 0.12), vec3(0.015, 0.015, 0.03), smoothstep(0.1, 0.8, el));
          // clouds lit from below by the city glow (magenta near horizon, teal higher)
          vec3 glow = mix(vec3(0.5, 0.15, 0.4), vec3(0.1, 0.3, 0.4), smoothstep(0.1, 0.6, el));
          vec3 c = base + cl * glow * 0.9 * (1.0 - smoothstep(0.5, 1.0, el) * 0.6);
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), this.clouds);
    dome.position.y = 0;
    dome.renderOrder = -11;
    this.group.add(dome);
    this.group.traverse((o) => o.layers.enable(LAYER_NO_REFLECT));
  }

  update(cam: THREE.Camera, t: number) {
    this.group.position.set(cam.position.x, 0, cam.position.z);
    this.clouds.uniforms.uTime.value = t;
  }
}

/** Procedural night-city environment map: dark surroundings with neon panels and street-light strips. */
export function createCityEnvMap(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060c);
  const add = (color: number, intensity: number, w: number, h: number, pos: THREE.Vector3) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.copy(pos);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  const cols = [0xff2fb4, 0x21f3ff, 0xffa020, 0x8a4dff, 0x2fff9a, 0xff3030];
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 46; i++) {
    const a = rnd() * Math.PI * 2;
    const y = rnd() * 14 - 2;
    const r = 18 + rnd() * 10;
    add(cols[i % cols.length], 1.5 + rnd() * 3, 1 + rnd() * 5, 0.5 + rnd() * 3, new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  // overhead street light strips (give the long specular streaks on the paint)
  for (let i = -3; i <= 3; i++) add(0xffd2a0, 4, 1.2, 0.3, new THREE.Vector3(i * 6, 9, 3));
  // dim sky gradient
  const sky = new THREE.Mesh(new THREE.SphereGeometry(60, 16, 8), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vP; void main(){ float h = normalize(vP).y; gl_FragColor = vec4(mix(vec3(0.02,0.02,0.03), vec3(0.08,0.05,0.14), smoothstep(-0.2, 0.6, h)), 1.0); }',
  }));
  scene.add(sky);
  // wet ground reflection hint
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x07070c }));
  ground.position.y = -3;
  scene.add(ground);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.02);
  pm.dispose();
  return rt.texture;
}
