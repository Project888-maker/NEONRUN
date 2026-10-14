import * as THREE from 'three';
import { poolUniforms } from './groundMaterial';

export interface FacadeParams {
  tileH: number; // meters covered by one texture tile vertically
  metalness: number;
  roughness: number;
  emissive: number; // window light strength
  threshold: number; // luminance threshold where pixels count as lit windows
}

export const FACADES: Record<string, FacadeParams> = {
  apartment: { tileH: 46, metalness: 0.0, roughness: 0.8, emissive: 2.2, threshold: 0.42 },
  office_glass: { tileH: 52, metalness: 0.7, roughness: 0.18, emissive: 2.0, threshold: 0.45 },
  tenement: { tileH: 24, metalness: 0.0, roughness: 0.85, emissive: 2.2, threshold: 0.40 },
  industrial: { tileH: 16, metalness: 0.35, roughness: 0.55, emissive: 1.8, threshold: 0.45 },
  megablock: { tileH: 40, metalness: 0.0, roughness: 0.75, emissive: 2.4, threshold: 0.40 },
  tower_lux: { tileH: 60, metalness: 0.6, roughness: 0.2, emissive: 2.6, threshold: 0.42 },
};

/** Unit box with its base at y=0 (x,z in -0.5..0.5) for instanced buildings. */
export function unitBox() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  g.deleteAttribute('uv');
  return g;
}

export function createBuildingMaterial(tex: THREE.Texture, p: FacadeParams, envMap: THREE.Texture | null) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: p.metalness, roughness: p.roughness, envMap, envMapIntensity: 0.9 });
  const img = tex.image as { width?: number; height?: number } | undefined;
  const aspect = (img?.width || 1024) / (img?.height || 1536);
  const uniforms = {
    uFacade: { value: tex },
    uTileH: { value: p.tileH },
    uTileW: { value: p.tileH * aspect },
    uEmissive: { value: p.emissive },
    uThresh: { value: p.threshold },
    uTime: poolUniforms.uTime,
    uRain: poolUniforms.uRain,
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aRand;
        uniform float uTileH; uniform float uTileW;
        varying vec2 vFUV; varying float vTop; varying vec4 vRand; varying float vWY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec3 lp = position * sc;
        float wy = instanceMatrix[3].y + lp.y;
        float u = abs(normal.x) > 0.5 ? lp.z * -sign(normal.x) : lp.x * sign(normal.z);
        vFUV = vec2((u + sc.x * 7.0 * aRand.x) / uTileW, wy / uTileH) + aRand.xy;
        vTop = step(0.5, normal.y);
        vRand = aRand;
        vWY = wy;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uFacade; uniform float uEmissive; uniform float uThresh; uniform float uTime; uniform float uRain;
        varying vec2 vFUV; varying float vTop; varying vec4 vRand; varying float vWY;
        float bHash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }`)
      .replace('#include <map_fragment>', `
        vec3 fac = texture2D(uFacade, vFUV).rgb;
        float lum = dot(fac, vec3(0.299, 0.587, 0.114));
        // window cells: per-cell on/off variation so neighbouring buildings differ
        vec2 cell = floor(vFUV * vec2(14.0, 20.0));
        float on = step(0.22 + vRand.z * 0.35, bHash(cell + vRand.xy * 91.0));
        float flick = 1.0 - 0.6 * step(0.995, bHash(cell + floor(uTime * 2.0 + vRand.w * 10.0)));
        float lit = smoothstep(uThresh, uThresh + 0.18, lum) * mix(0.25, 1.0, on) * flick;
        vec3 base = fac * mix(1.0, 0.55, uRain * 0.5);
        vec3 roof = vec3(0.045, 0.047, 0.055) * (0.8 + 0.4 * bHash(floor(vFUV * 9.0)));
        diffuseColor.rgb *= mix(base * (1.0 - lit * 0.7), roof, vTop);
        vec3 winEmit = fac * fac * lit * uEmissive * (0.7 + vRand.w * 0.6) * (1.0 - vTop);
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += winEmit;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.6, uRain);
        roughnessFactor = mix(roughnessFactor, 0.9, vTop);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor *= (1.0 - vTop) * (1.0 - lit);`);
  };
  mat.customProgramCacheKey = () => 'building';
  return mat;
}
