import * as THREE from 'three';
import { poolUniforms } from './groundMaterial';

const fogFade = /* glsl */ `
  #ifdef USE_FOG
    float ffac = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float ffac = 0.0;
  #endif
`;

/**
 * Instanced quads sampling a texture atlas. Per-instance attributes:
 *  aUv: atlas rect (u, v, w, h) in GL uv space; aSeed: random seed for flicker.
 */
export function createAtlasMaterial(map: THREE.Texture, opts: { additive: boolean; intensity: number; flicker: number; doubleSide?: boolean; fogToBlack?: boolean }) {
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.generateMipmaps = true;
  const uniforms: Record<string, THREE.IUniform> = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uIntensity: { value: opts.intensity }, uFlicker: { value: opts.flicker } }]);
  uniforms.map = { value: map };
  uniforms.uTime = poolUniforms.uTime;
  return new THREE.ShaderMaterial({
    uniforms,
    defines: { ADDITIVE: opts.additive ? 1 : 0 },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec4 aUv; attribute float aSeed;
      varying vec2 vUv; varying float vSeed;
      void main(){
        vUv = aUv.xy + uv * aUv.zw;
        vSeed = aSeed;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform sampler2D map; uniform float uIntensity; uniform float uFlicker; uniform float uTime;
      varying vec2 vUv; varying float vSeed;
      void main(){
        vec3 c = texture2D(map, vUv).rgb;
        float t = uTime * (1.0 + vSeed * 3.0) + vSeed * 100.0;
        float f = 1.0;
        if (uFlicker > 0.0) {
          float n = fract(sin(floor(t * 8.0) * 12.9898 + vSeed * 78.233) * 43758.5453);
          f = mix(1.0, step(0.12, n) * (0.85 + 0.15 * sin(t * 50.0)), uFlicker * step(0.8, vSeed));
          f *= 0.9 + 0.1 * sin(t * 2.0);
        }
        vec3 col = c * uIntensity * f;
        ${fogFade}
        #if ADDITIVE == 1
          col *= (1.0 - ffac);
          gl_FragColor = vec4(col, 1.0);
        #else
          col = mix(col, fogColor, ffac);
          gl_FragColor = vec4(col, 1.0);
        #endif
      }`,
    fog: true,
    transparent: opts.additive,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: !opts.additive,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/** Volumetric-looking light cone under street lamps / spotlights (instanced, additive). aColor per instance. */
export function createConeMaterial(strength = 0.35) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uStrength: { value: strength } }]) as any,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec3 aColor;
      varying vec3 vColor; varying float vH; varying vec3 vN; varying vec3 vV;
      void main(){
        vColor = aColor;
        vH = uv.y; // 1 at apex, 0 at base
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uStrength;
      varying vec3 vColor; varying float vH; varying vec3 vN; varying vec3 vV;
      void main(){
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float a = pow(facing, 2.0) * pow(vH, 1.6) * uStrength;
        ${fogFade}
        a *= 1.0 - ffac * 0.85;
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    fog: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Traffic signal lamp discs: state computed in the shader from time + per-instance phase. */
export const TRAFFIC_CYCLE = 24;
export function trafficState(axis: number, t: number, offset: number): 0 | 1 | 2 {
  const c = (((t + offset) % TRAFFIC_CYCLE) + TRAFFIC_CYCLE) % TRAFFIC_CYCLE;
  if (axis === 0) return c < 9 ? 2 : c < 11 ? 1 : 0;
  return c < 12 ? 0 : c < 21 ? 2 : c < 23 ? 1 : 0;
}

export function createTrafficLampMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: poolUniforms.uTime },
    vertexShader: /* glsl */ `
      attribute vec3 aPhase; // offset, axis, colorIndex (0 red 1 amber 2 green)
      uniform float uTime;
      varying vec3 vCol;
      void main(){
        float c = mod(uTime + aPhase.x, ${TRAFFIC_CYCLE.toFixed(1)});
        float st = aPhase.y < 0.5 ? (c < 9.0 ? 2.0 : (c < 11.0 ? 1.0 : 0.0)) : (c < 12.0 ? 0.0 : (c < 21.0 ? 2.0 : (c < 23.0 ? 1.0 : 0.0)));
        vec3 pal = aPhase.z < 0.5 ? vec3(1.0, 0.05, 0.03) : (aPhase.z < 1.5 ? vec3(1.0, 0.5, 0.0) : vec3(0.1, 1.0, 0.35));
        vCol = pal * (abs(st - aPhase.z) < 0.1 ? 9.0 : 0.06);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol, 1.0); }`,
  });
}
