import * as THREE from 'three';
import { LAYER_NO_REFLECT } from '../render/reflector';
import { poolUniforms, MAX_POOLS } from '../render/groundMaterial';

/**
 * GPU rain. Each drop is a thin camera-facing streak whose length is how far it travels during one
 * camera exposure (~1/30 s), relative to the viewer: about 30 cm when standing, longer and slanted
 * from a fast car — like real footage. Drops fall at a real 7–9.5 m/s (not 26 m/s), and they are only
 * visible where light hits them: each drop takes its colour from the nearby neon signs, street lamps
 * and headlights (the same light pools that light the wet road), so rain glows in light and nearly
 * disappears in the dark.
 */
export class Rain {
  mesh: THREE.Mesh;
  uniforms = {
    uTime: poolUniforms.uTime,
    uPoolPos: poolUniforms.uPoolPos,
    uPoolCol: poolUniforms.uPoolCol,
    uCam: { value: new THREE.Vector3() },
    uCamVel: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2(0.9, 0.35) },
    uIntensity: { value: 1 },
    uPx: { value: 0.0011 }, // metres per pixel at 1 m distance (set from fov / screen height)
    uGain: { value: 1 },
  };
  private geo: THREE.InstancedBufferGeometry;

  constructor(count: number) {
    const g = new THREE.InstancedBufferGeometry();
    // quad: x across the streak (-1..1), y along it (0 = tail, 1 = head)
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const off = new Float32Array(count * 3), seed = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      off.set([Math.random() * 40 - 20, Math.random() * 24, Math.random() * 40 - 20], i * 3);
      seed.set([Math.random(), Math.random()], i * 2);
    }
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 2));
    g.instanceCount = count;
    this.geo = g;
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCam; uniform vec3 uCamVel; uniform vec2 uWind; uniform float uIntensity; uniform float uPx;
        uniform vec4 uPoolPos[${MAX_POOLS}]; uniform vec3 uPoolCol[${MAX_POOLS}];
        attribute vec3 aOff; attribute vec2 aSeed;
        varying vec2 vUv; varying vec3 vCol; varying float vA;
        void main(){
          float speed = 7.0 + aSeed.x * 2.5;                         // terminal velocity of 2–4 mm drops
          vec3 vel = vec3(uWind.x, -speed, uWind.y);
          vec3 p = aOff;
          p.y = mod(aOff.y - speed * uTime - (uCam.y - 8.0), 24.0) + uCam.y - 8.0;
          p.xz = mod(aOff.xz + uWind * uTime - uCam.xz + 20.0, 40.0) - 20.0 + uCam.xz;
          // motion blur during the exposure, as seen from the (possibly moving) camera
          vec3 rel = vel - uCamVel;
          vec3 streak = rel * 0.034 + normalize(rel) * 0.03;               // ~1/30 s exposure + drop size
          vec4 head = viewMatrix * vec4(p, 1.0);
          vec4 tail = viewMatrix * vec4(p - streak, 1.0);
          vec3 axis = head.xyz - tail.xyz;
          vec3 side = normalize(cross(axis, head.xyz + vec3(1e-4)));
          float dist = max(0.05, -head.z);
          float w = max(0.0008, dist * uPx * 0.5);                      // ~1 mm drop, about one pixel wide
          vec3 pos = mix(tail.xyz, head.xyz, position.y) + side * position.x * w;
          gl_Position = projectionMatrix * vec4(pos, 1.0);
          // light falling on the drop: dim sky glow + every nearby light pool (signs, lamps, headlights)
          vec3 L = vec3(0.10, 0.11, 0.135);
          for (int i = 0; i < ${MAX_POOLS}; i++) {
            vec4 lp = uPoolPos[i];
            float a = clamp(1.0 - distance(p, lp.xyz) / (lp.w * 1.5), 0.0, 1.0);
            L += uPoolCol[i] * a * a;
          }
          vCol = L;
          // drops act as tiny lenses that catch the light around them, so they read brighter than their size;
          // far ones still thin out a little
          float cover = clamp(0.004 / w, 0.55, 1.0);
          vA = smoothstep(0.35, 1.6, dist) * (1.0 - smoothstep(13.0, 21.0, dist)) * step(aSeed.y, uIntensity) * cover;
          vUv = position.xy;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uGain;
        varying vec2 vUv; varying vec3 vCol; varying float vA;
        void main(){
          float across = 1.0 - abs(vUv.x);
          float along = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.8, 1.0, vUv.y));
          float a = across * across * along * vA;
          gl_FragColor = vec4(min(vCol, vec3(2.0)) * a * 0.85 * uGain, 1.0);
        }`,
      // falling drops put the tail above the head, which flips the quad's winding: draw both faces
      side: THREE.DoubleSide,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }

  /** How many drops to draw (quality setting). */
  setCount(n: number) { this.geo.instanceCount = Math.min(n, (this.geo.getAttribute('aOff') as THREE.InstancedBufferAttribute).count); }

  /** viewerVel: velocity of the camera's subject (car or walking hero), which stretches and tilts streaks */
  update(cam: THREE.PerspectiveCamera, viewerVel: THREE.Vector3, screenHeight = innerHeight) {
    this.uniforms.uCam.value.copy(cam.position);
    this.uniforms.uCamVel.value.lerp(viewerVel, 0.25);
    this.uniforms.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(200, screenHeight);
  }
}

/** Expanding splash rings on the ground around the camera (fully GPU). */
export class Splashes {
  mesh: THREE.InstancedMesh;
  constructor(count: number) {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: poolUniforms.uTime, uCam: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCam;
        varying vec2 vUv; varying float vLife;
        float h(float n){ return fract(sin(n) * 43758.5453); }
        void main(){
          float id = float(gl_InstanceID);
          float period = 0.5 + h(id * 3.1) * 0.5;
          float t = uTime / period + h(id);
          float cycle = floor(t);
          vLife = fract(t);
          vec2 off = vec2(h(id + cycle * 17.3), h(id * 7.7 + cycle * 3.1)) * 2.0 - 1.0;
          vec3 c = vec3(uCam.x + off.x * 22.0, 0.03, uCam.z + off.y * 22.0);
          float s = 0.05 + vLife * 0.35;
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * vec4(c + position * s, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying float vLife;
        void main(){
          float r = length(vUv - 0.5) * 2.0;
          float ring = smoothstep(0.75, 0.9, r) * (1.0 - smoothstep(0.92, 1.0, r));
          float a = ring * (1.0 - vLife) * 0.5;
          gl_FragColor = vec4(vec3(0.6, 0.7, 0.85) * a, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(g, m, count);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }
  update(cam: THREE.Camera) { (this.mesh.material as THREE.ShaderMaterial).uniforms.uCam.value.copy(cam.position); }
}

function softTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const dx = (x - 64) / 64, dy = (y - 64) / 64;
    const r = Math.sqrt(dx * dx + dy * dy);
    const n = 0.75 + 0.25 * Math.sin(x * 0.21 + Math.sin(y * 0.13) * 3) * Math.sin(y * 0.17 + Math.cos(x * 0.11) * 2);
    const a = Math.max(0, 1 - r) ** 1.8 * n;
    const i = (y * 128 + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

export interface Particle { p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; size: number; grow: number; color: THREE.Color; alpha: number; drag: number; gravity: number }

/** CPU particle pool rendered as point sprites (spray, smoke, steam, sparks, boost trail). */
export class Particles {
  points: THREE.Points;
  private ps: Particle[] = [];
  private pos: Float32Array; private col: Float32Array; private size: Float32Array; private alpha: Float32Array;
  constructor(public max: number, additive: boolean, tex = softTexture()) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, uScale: { value: 600 } }]),
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          vColor = aColor; vAlpha = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mvPosition.z, 0.1);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform sampler2D map; varying vec3 vColor; varying float vAlpha;
        void main(){
          float a = texture2D(map, gl_PointCoord).a * vAlpha;
          #ifdef USE_FOG
            float ff = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            a *= 1.0 - ff * 0.7;
          #endif
          ${additive ? 'gl_FragColor = vec4(vColor * a, 1.0);' : 'gl_FragColor = vec4(vColor, a);'}
        }`,
      transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    m.uniforms.map.value = tex;
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_NO_REFLECT);
  }

  setScale(h: number, fov: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, color: THREE.Color, alpha = 1, opts: { grow?: number; drag?: number; gravity?: number } = {}) {
    if (this.ps.length >= this.max) this.ps.shift();
    this.ps.push({ p: p.clone(), v: v.clone(), life, max: life, size, grow: opts.grow ?? 1, color: color.clone(), alpha, drag: opts.drag ?? 0.5, gravity: opts.gravity ?? 0 });
  }

  update(dt: number) {
    let n = 0;
    const keep: Particle[] = [];
    for (const q of this.ps) {
      q.life -= dt;
      if (q.life <= 0) continue;
      q.v.multiplyScalar(Math.max(0, 1 - q.drag * dt));
      q.v.y -= q.gravity * dt;
      q.p.addScaledVector(q.v, dt);
      if (q.gravity > 0 && q.p.y < 0.05) { q.p.y = 0.05; q.v.y *= -0.3; q.v.x *= 0.6; q.v.z *= 0.6; }
      const t = 1 - q.life / q.max;
      this.pos.set([q.p.x, q.p.y, q.p.z], n * 3);
      this.col.set([q.color.r, q.color.g, q.color.b], n * 3);
      this.size[n] = q.size * (1 + t * q.grow);
      this.alpha[n] = q.alpha * Math.min(1, t * 6) * (1 - t);
      keep.push(q);
      n++;
    }
    this.ps = keep;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) (g.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Large drifting haze sprites between buildings for layered volumetric fog. */
export class FogLayers {
  group = new THREE.Group();
  private sprites: THREE.Sprite[] = [];
  constructor(count: number) {
    const tex = softTexture();
    for (let i = 0; i < count; i++) {
      const hue = [0.62, 0.85, 0.55, 0.75][i % 4];
      const mat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color().setHSL(hue, 0.45, 0.16), transparent: true, opacity: 0.0, depthWrite: false, fog: false });
      const s = new THREE.Sprite(mat);
      s.layers.set(LAYER_NO_REFLECT);
      this.sprites.push(s);
      this.group.add(s);
      s.userData.base = 0.05 + Math.random() * 0.08;
      s.userData.drift = new THREE.Vector3((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5);
    }
  }
  private place(s: THREE.Sprite, cam: THREE.Vector3, far = false) {
    const a = Math.random() * Math.PI * 2;
    const r = far ? 120 + Math.random() * 60 : 25 + Math.random() * 150;
    const size = 30 + Math.random() * 60;
    s.position.set(cam.x + Math.cos(a) * r, 8 + Math.random() * 34, cam.z + Math.sin(a) * r);
    s.scale.set(size * 1.6, size * 0.6, 1);
  }
  update(dt: number, cam: THREE.Vector3, density: number) {
    for (const s of this.sprites) {
      if (!s.userData.init) { this.place(s, cam); s.userData.init = true; }
      s.position.addScaledVector(s.userData.drift, dt);
      const d = Math.hypot(s.position.x - cam.x, s.position.z - cam.z);
      if (d > 190) this.place(s, cam, true);
      // fade sprites out when the camera gets close (avoid flat-card look)
      const near = THREE.MathUtils.smoothstep(d, 12, 40);
      (s.material as THREE.SpriteMaterial).opacity = s.userData.base * near * density;
    }
  }
}
