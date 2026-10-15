import * as THREE from 'three';
import { PITCH, HALF, ROAD_W } from '../world/layout';
import type { PlanarReflector } from './reflector';

export const MAX_POOLS = 40;

/** Shared light-pool uniforms: nearby neon signs/street lamps lighting wet ground cheaply. */
export const poolUniforms = {
  uPoolPos: { value: Array.from({ length: MAX_POOLS }, () => new THREE.Vector4(0, -100, 0, 1)) },
  uPoolCol: { value: Array.from({ length: MAX_POOLS }, () => new THREE.Vector3()) },
  uTime: { value: 0 },
  uRain: { value: 1 },
};

const common = /* glsl */ `
uniform vec4 uPoolPos[${MAX_POOLS}];
uniform vec3 uPoolCol[${MAX_POOLS}];
uniform float uTime;
uniform float uRain;
varying vec3 vWPos;
float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(gHash(i), gHash(i+vec2(1,0)), f.x), mix(gHash(i+vec2(0,1)), gHash(i+vec2(1,1)), f.x), f.y); }
float gFbm(vec2 p){ return gNoise(p)*0.55 + gNoise(p*2.1+7.3)*0.3 + gNoise(p*4.3+1.7)*0.15; }
// animated rain ripple normal offset
vec2 ripples(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 2; k++){
    vec2 q = p * (1.6 + float(k)*0.9) + float(k)*13.7;
    vec2 id = floor(q); vec2 f = fract(q) - 0.5;
    float rnd = gHash(id + float(k));
    vec2 c = vec2(gHash(id*1.3), gHash(id*2.1)) - 0.5;
    float ph = fract(t * 0.9 + rnd);
    vec2 d = f - c*0.6;
    float r = length(d);
    float ring = sin((r - ph*0.5) * 40.0) * (1.0 - smoothstep(0.5*ph-0.05, 0.5*ph+0.05, r)) * smoothstep(0.0, 0.1, r) * (1.0 - ph);
    acc += d / max(r, 1e-3) * ring;
  }
  return acc * 0.35;
}
`;

export interface GroundOpts {
  albedo: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture;
  tile: number; markings: boolean; reflector?: PlanarReflector; reflectStrength: number; puddles: number;
  color?: THREE.Color;
}

export function createGroundMaterial(o: GroundOpts) {
  const mat = new THREE.MeshStandardMaterial({ color: o.color ?? 0xffffff, roughness: 1, metalness: 0, map: o.albedo });
  for (const t of [o.albedo, o.normal, o.rough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
  const uniforms = {
    ...poolUniforms,
    uNormalMap2: { value: o.normal },
    uRoughMap2: { value: o.rough },
    uTile: { value: o.tile },
    uReflect: { value: o.reflector ? o.reflector.rt.texture : null },
    uReflectMatrix: { value: o.reflector ? o.reflector.textureMatrix : new THREE.Matrix4() },
    uReflectStrength: { value: o.reflectStrength },
    uPuddles: { value: o.puddles },
    uHasReflect: { value: o.reflector ? 1 : 0 },
  };
  mat.userData.uniforms = uniforms;
  mat.defines = { ...(mat.defines || {}), MARKINGS: o.markings ? 1 : 0 };
  mat.customProgramCacheKey = () => `ground-${o.markings}-${!!o.reflector}`;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 wpG = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpG = instanceMatrix * wpG;
        #endif
        vWPos = (modelMatrix * wpG).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        ${common}
        uniform sampler2D uNormalMap2; uniform sampler2D uRoughMap2; uniform float uTile;
        uniform sampler2D uReflect; uniform mat4 uReflectMatrix; uniform float uReflectStrength; uniform float uPuddles; uniform float uHasReflect;
        const float PITCH = ${PITCH.toFixed(1)}; const float HALFW = ${HALF.toFixed(1)}; const float RW = ${(ROAD_W / 2).toFixed(2)};
        float gPaint; float gPuddle; vec2 gRip;
        float lineAA(float d, float w){ float fw = fwidth(d) + 1e-4; return 1.0 - smoothstep(w - fw, w + fw, abs(d)); }
        float markings(vec2 p){
          vec2 g = p + HALFW;
          vec2 d = mod(g + PITCH*0.5, PITCH) - PITCH*0.5; // signed distance to nearest centerline (x: vertical road, y: horizontal road)
          float m = 0.0;
          bool inInter = abs(d.x) < RW && abs(d.y) < RW;
          if (inInter) return 0.0;
          // vertical road (runs along z): lateral = d.x, along = d.y
          if (abs(d.x) < RW) {
            float along = abs(d.y);
            m += (lineAA(d.x - 0.18, 0.08) + lineAA(d.x + 0.18, 0.08)) * 0.9 * step(RW + 4.0, along);
            m += lineAA(abs(d.x) - 3.5, 0.07) * step(0.5, fract(p.y / 6.0)) * step(RW + 4.0, along);
            m += lineAA(abs(d.x) - 6.55, 0.08) * step(RW + 0.5, along);
            float cw = step(RW + 0.6, along) * step(along, RW + 3.6) * step(0.5, fract(p.x / 1.1)) * step(abs(d.x), RW - 0.5);
            m += cw;
            m += lineAA(along - (RW + 4.3), 0.22) * step(0.0, -d.x * sign(d.y)) * step(abs(d.x), RW - 0.4);
          }
          if (abs(d.y) < RW) {
            float along = abs(d.x);
            m += (lineAA(d.y - 0.18, 0.08) + lineAA(d.y + 0.18, 0.08)) * 0.9 * step(RW + 4.0, along);
            m += lineAA(abs(d.y) - 3.5, 0.07) * step(0.5, fract(p.x / 6.0)) * step(RW + 4.0, along);
            m += lineAA(abs(d.y) - 6.55, 0.08) * step(RW + 0.5, along);
            float cw = step(RW + 0.6, along) * step(along, RW + 3.6) * step(0.5, fract(p.y / 1.1)) * step(abs(d.y), RW - 0.5);
            m += cw;
            m += lineAA(along - (RW + 4.3), 0.22) * step(0.0, d.y * sign(d.x)) * step(abs(d.y), RW - 0.4);
          }
          return clamp(m, 0.0, 1.0);
        }
        bool isYellow(vec2 p){ vec2 d = mod(p + HALFW + PITCH*0.5, PITCH) - PITCH*0.5; return min(abs(d.x), abs(d.y)) < 0.3; }
      `)
      .replace('#include <map_fragment>', `
        vec2 guv = vWPos.xz / uTile;
        vec4 texelColor = texture2D(map, guv);
        texelColor.rgb *= mix(0.85, 1.1, gNoise(vWPos.xz * 0.05));
        gPaint = 0.0;
        #if MARKINGS == 1
          float wear = smoothstep(0.15, 0.55, texture2D(uRoughMap2, guv * 0.7).r);
          gPaint = markings(vWPos.xz) * mix(0.55, 1.0, wear);
          vec3 paintCol = isYellow(vWPos.xz) ? vec3(0.85, 0.62, 0.12) : vec3(0.82);
          texelColor.rgb = mix(texelColor.rgb, paintCol, gPaint);
        #endif
        float pn = gFbm(vWPos.xz * 0.045 + 3.0) * 0.75 + gFbm(vWPos.xz * 0.21) * 0.25;
        gPuddle = smoothstep(0.58, 0.64, pn * uPuddles + (1.0 - uPuddles) * 0.0) * uRain;
        gRip = ripples(vWPos.xz, uTime) * uRain;
        texelColor.rgb *= mix(0.62, 1.0, 1.0 - uRain * 0.6); // wet darkening
        texelColor.rgb *= 1.0 - gPuddle * 0.55;
        diffuseColor *= texelColor;
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = texture2D(uRoughMap2, guv).r;
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.45, uRain);
        roughnessFactor = mix(roughnessFactor, 0.03, gPuddle);
        roughnessFactor = max(roughnessFactor, gPaint * 0.35);
      `)
      .replace('#include <normal_fragment_maps>', `
        vec3 tn = texture2D(uNormalMap2, guv).xyz * 2.0 - 1.0;
        float ns = mix(1.0, 0.05, gPuddle);
        vec3 wn = normalize(vec3(tn.x * ns + gRip.x * (0.25 + gPuddle), 1.0, -tn.y * ns + gRip.y * (0.25 + gPuddle)));
        normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
      `)
      .replace('#include <opaque_fragment>', `
        // ---- light pools from neon signs & lamps (diffuse + wet specular streak)
        vec3 V = normalize(cameraPosition - vWPos);
        vec3 poolAcc = vec3(0.0);
        for (int i = 0; i < ${MAX_POOLS}; i++) {
          vec4 lp = uPoolPos[i];
          vec3 L = lp.xyz - vWPos;
          float d = length(L);
          float r = lp.w;
          if (d > r * 1.8) continue;
          L /= d;
          float att = pow(clamp(1.0 - d / r, 0.0, 1.0), 2.0);
          float ndl = max(dot(wn, L), 0.0);
          vec3 H = normalize(L + V);
          float rr = max(roughnessFactor, 0.04);
          float spec = pow(max(dot(wn, H), 0.0), 2.0 / (rr * rr * rr) ) * (1.0 - rr) * 3.0;
          float att2 = pow(clamp(1.0 - d / (r * 1.8), 0.0, 1.0), 1.5);
          poolAcc += uPoolCol[i] * (att * ndl * diffuseColor.rgb * 1.6 + spec * att2 * 0.6);
        }
        outgoingLight += poolAcc;
        // ---- planar reflection
        if (uHasReflect > 0.5) {
          vec4 rc = uReflectMatrix * vec4(vWPos, 1.0);
          vec2 ruv = rc.xy / rc.w + wn.xz * (0.012 + 0.03 * (1.0 - gPuddle));
          float rough = clamp(roughnessFactor, 0.0, 1.0);
          float lod = rough * 6.0;
          vec3 refl = vec3(0.0);
          float wsum = 0.0;
          for (int k = 0; k < 6; k++) {
            float fk = float(k);
            float w = 1.0 - fk / 7.0;
            refl += textureLod(uReflect, ruv + vec2(0.0, fk * 0.012 * (0.3 + rough)), lod).rgb * w;
            wsum += w;
          }
          refl /= wsum;
          float cosT = clamp(dot(V, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
          float F = 0.03 + 0.97 * pow(1.0 - cosT, 5.0);
          float amt = uReflectStrength * mix(mix(0.35, 0.8, uRain) * (1.0 - rough * 0.8), 1.0, gPuddle) * (1.0 - gPaint * 0.6);
          outgoingLight = mix(outgoingLight, refl, clamp(F * amt + amt * 0.25, 0.0, 1.0));
        }
        #include <opaque_fragment>
      `);
  };
  return mat;
}
