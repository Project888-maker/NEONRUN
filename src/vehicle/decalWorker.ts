// Projects the livery decals off the main thread. DecalGeometry clips every body triangle against
// each projector box, which took 170-290 ms per garage tap / mission start on the main thread.
import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

export interface DecalJob { id: number; position: Float32Array; normal: Float32Array | null; index: Uint32Array | null; matrix: number[] }
export interface DecalResult { id: number; parts: { position: Float32Array; normal: Float32Array | null; uv: Float32Array }[] }

// projector boxes in car-local space: both flanks and the hood
const PROJECTORS: [THREE.Vector3, THREE.Euler, THREE.Vector3][] = [
  [new THREE.Vector3(1.0, 0.75, 0), new THREE.Euler(0, Math.PI / 2, 0), new THREE.Vector3(4.2, 1.0, 1.2)],
  [new THREE.Vector3(-1.0, 0.75, 0), new THREE.Euler(0, -Math.PI / 2, 0), new THREE.Vector3(4.2, 1.0, 1.2)],
  [new THREE.Vector3(0, 1.1, 1.3), new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2), new THREE.Vector3(1.6, 1.0, 1.2)],
];

self.onmessage = (e: MessageEvent<DecalJob>) => {
  const job = e.data;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(job.position, 3));
  if (job.normal) geo.setAttribute('normal', new THREE.BufferAttribute(job.normal, 3));
  if (job.index) geo.setIndex(new THREE.BufferAttribute(job.index, 1));
  const mesh = new THREE.Mesh(geo);
  mesh.matrixWorld.fromArray(job.matrix); // body mesh relative to the car root
  const parts: DecalResult['parts'] = [];
  const transfer: ArrayBuffer[] = [];
  for (const [p, r, s] of PROJECTORS) {
    const d = new DecalGeometry(mesh, p, r, s);
    const part = {
      position: d.attributes.position.array as Float32Array,
      normal: (d.attributes.normal?.array as Float32Array) ?? null,
      uv: d.attributes.uv.array as Float32Array,
    };
    parts.push(part);
    transfer.push(part.position.buffer as ArrayBuffer, part.uv.buffer as ArrayBuffer);
    if (part.normal) transfer.push(part.normal.buffer as ArrayBuffer);
  }
  (self as unknown as Worker).postMessage({ id: job.id, parts } satisfies DecalResult, transfer);
};
