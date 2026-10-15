import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Physical/gameplay definition of each drivable car (models come from blender/process_car.py). */
export interface CarDef {
  id: string; name: string; price: number; desc: string;
  mass: number; power: number; topSpeed: number; grip: number; traffic: number; // traffic spawn weight
}

export const CAR_DEFS: CarDef[] = [
  { id: 'car_hatch', name: 'Rustbucket Hatch', price: 0, desc: 'Light, slow, honest.', mass: 1050, power: 0.62, topSpeed: 42, grip: 0.92, traffic: 3 },
  { id: 'car_taxi', name: 'City Cab', price: 900, desc: 'Every courier starts in one.', mass: 1350, power: 0.78, topSpeed: 48, grip: 0.97, traffic: 4 },
  { id: 'car_van', name: 'Parcel Van', price: 1200, desc: 'Heavy, tall, unbreakable.', mass: 2300, power: 0.7, topSpeed: 40, grip: 0.9, traffic: 3 },
  { id: 'car_pickup', name: 'Trail Pickup', price: 2200, desc: 'Big tires, big torque.', mass: 2100, power: 0.95, topSpeed: 47, grip: 1.02, traffic: 2 },
  { id: 'car_lux', name: 'Executive', price: 3500, desc: 'Smooth, fast, discreet.', mass: 1950, power: 1.05, topSpeed: 56, grip: 1.0, traffic: 2 },
  { id: 'car_classic', name: 'Seventy-Two', price: 4200, desc: 'Old iron, loves to slide.', mass: 1600, power: 1.1, topSpeed: 54, grip: 0.9, traffic: 1 },
  { id: 'car_police', name: 'Interceptor', price: 6000, desc: 'Seized from the PD. Hush.', mass: 1800, power: 1.2, topSpeed: 60, grip: 1.05, traffic: 1 },
  { id: 'car_super', name: 'Violet Hyper', price: 12000, desc: 'The fastest thing in the city.', mass: 1400, power: 1.45, topSpeed: 70, grip: 1.15, traffic: 0.5 },
];
export const carDef = (id: string) => CAR_DEFS.find((d) => d.id === id);

export interface CarSpec {
  id: string; length: number; width: number; height: number; wheelRadius: number;
  wheels: Record<'FL' | 'FR' | 'RL' | 'RR', [number, number, number]>;
}

export interface CarAsset {
  spec: CarSpec;
  body: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  wheels: Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }[]>;
}

function dequant(g: THREE.BufferGeometry) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    if (a.array instanceof Float32Array && !(a as any).isInterleavedBufferAttribute) continue;
    const f = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
  }
  return g;
}

/** Bake a processed car GLB into body parts + per-corner wheel parts (wheels centred on their axle). */
export function bakeCar(gltf: GLTF, spec: CarSpec): CarAsset {
  const asset: CarAsset = { spec, body: [], wheels: { FL: [], FR: [], RL: [], RR: [] } };
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const key = (m.name.match(/wheel_(FL|FR|RL|RR)/) || (m.parent?.name || '').match(/wheel_(FL|FR|RL|RR)/))?.[1];
    const g = dequant(m.geometry.clone());
    g.applyMatrix4(m.matrixWorld);
    if (key) {
      const c = spec.wheels[key as 'FL'];
      g.translate(-c[0], -c[1], -c[2]);
      asset.wheels[key].push({ geometry: g, material: m.material as THREE.Material });
    } else {
      asset.body.push({ geometry: g, material: m.material as THREE.Material });
    }
  });
  return asset;
}

/** Shared uniforms for car light emission; traffic overrides brake per instance via aBrake. */
export interface CarLightUniforms { uHalfLen: { value: number }; uHead: { value: number }; uTail: { value: number }; uBrake: { value: number } }

/**
 * Make the car's own baked head/tail lights glow: bright whitish texels on the front of the car
 * become headlights, red texels on the rear become tail/brake lights.
 */
export function patchCarLights(mat: THREE.MeshStandardMaterial, halfLen: number, instanced: boolean): CarLightUniforms {
  const u: CarLightUniforms = { uHalfLen: { value: halfLen }, uHead: { value: 6 }, uTail: { value: 2.2 }, uBrake: { value: 0 } };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCarPos;${instanced ? '\nattribute float aBrake; varying float vBrake;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCarPos = position;${instanced ? '\nvBrake = aBrake;' : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCarPos; uniform float uHalfLen; uniform float uHead; uniform float uTail; uniform float uBrake;${instanced ? '\nvarying float vBrake;' : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_MAP
        {
          vec3 tc = sampledDiffuseColor.rgb;
          float lum = dot(tc, vec3(0.299, 0.587, 0.114));
          float front = smoothstep(uHalfLen - 0.55, uHalfLen - 0.2, vCarPos.z) * step(0.35, vCarPos.y);
          float rear = (1.0 - smoothstep(-uHalfLen + 0.2, -uHalfLen + 0.6, vCarPos.z)) * step(0.3, vCarPos.y);
          float sat = max(tc.r, max(tc.g, tc.b)) - min(tc.r, min(tc.g, tc.b));
          float head = front * smoothstep(0.55, 0.85, lum) * (1.0 - smoothstep(0.25, 0.5, sat));
          float red = rear * smoothstep(0.08, 0.25, tc.r - max(tc.g, tc.b)) * smoothstep(0.15, 0.4, tc.r);
          float brake = ${instanced ? 'max(uBrake, vBrake)' : 'uBrake'};
          totalEmissiveRadiance += vec3(0.9, 0.95, 1.0) * head * uHead + vec3(1.0, 0.04, 0.02) * red * (uTail + brake * 7.0);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `carlights-${instanced}`;
  mat.needsUpdate = true;
  return u;
}

/** Wet clear-coat look for generated car paint. */
export function carPaint(src: THREE.MeshStandardMaterial, envMap: THREE.Texture | null) {
  const p = new THREE.MeshPhysicalMaterial({
    map: src.map, normalMap: src.normalMap, roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap,
    roughness: 1, metalness: 1, clearcoat: 0.85, clearcoatRoughness: 0.08, envMap, envMapIntensity: 1.3,
  });
  p.name = 'paint';
  return p;
}
