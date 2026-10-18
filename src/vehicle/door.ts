// The car models are one solid shell, so there is no door to open: the courier used to climb in and out
// straight through the bodywork. This cuts the driver's door out of the shell (the outward-facing panel
// between the front wheel arch and the B-pillar), hinges it at its front edge, and puts a dark cabin
// behind the opening so you see an interior, not the far side of the car, while it is open.
import * as THREE from 'three';

export interface DoorCut {
  /** the shell without the door */
  rest: THREE.BufferGeometry;
  /** the door panel, in car space (place it under a pivot at `hinge`, offset by -hinge) */
  door: THREE.BufferGeometry;
  hinge: THREE.Vector3;
  /** inside of the cabin: centre and size of a box seen from within */
  cabin: { center: THREE.Vector3; size: THREE.Vector3 };
}

const cache = new Map<string, DoorCut | null>();

/**
 * @param geo body shell in car space (+z forward, driver side +x, ground at y = 0)
 * @param frontZ z of the front axle, @param rearZ z of the rear axle, @param r wheel radius
 */
export function cutDoor(geo: THREE.BufferGeometry, frontZ: number, rearZ: number, r: number, key = geo.uuid): DoorCut | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const zFront = frontZ - r - 0.1;
  const len = THREE.MathUtils.clamp((zFront - (rearZ + r)) * 0.55, 0.9, 1.25);
  const zRear = zFront - len;
  const ySill = Math.max(bb.min.y + 0.06, r * 0.8);
  const yTop = bb.min.y + (bb.max.y - bb.min.y) * 0.9;
  const xMin = bb.max.x * 0.45;
  const index = geo.index ? (geo.index.array as ArrayLike<number>) : null;
  const tris = index ? index.length / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (index ? index[t * 3 + k] : t * 3 + k);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  const restIdx: number[] = [], doorIdx: number[] = [];
  let hingeX = -Infinity;
  for (let t = 0; t < tris; t++) {
    const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    n.subVectors(c, b).cross(e.subVectors(a, b)).normalize();
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
    const inDoor = cx > xMin && n.x > 0.25 && cz < zFront && cz > zRear && cy > ySill && cy < yTop;
    (inDoor ? doorIdx : restIdx).push(i0, i1, i2);
    if (inDoor && Math.abs(cz - zFront) < 0.15) hingeX = Math.max(hingeX, cx);
  }
  // too few triangles to be a door (odd model): leave the car alone
  if (doorIdx.length < 3 * 40) { cache.set(key, null); return null; }
  const share = (idx: number[]) => {
    const g = new THREE.BufferGeometry();
    for (const [k, v] of Object.entries(geo.attributes)) g.setAttribute(k, v);
    g.setIndex(idx);
    g.boundingBox = bb.clone();
    g.computeBoundingSphere();
    return g;
  };
  const hinge = new THREE.Vector3(Number.isFinite(hingeX) ? hingeX : bb.max.x * 0.9, 0, zFront);
  const cabinW = bb.max.x - bb.min.x;
  const cut: DoorCut = {
    rest: share(restIdx), door: share(doorIdx), hinge,
    cabin: {
      center: new THREE.Vector3((bb.max.x + bb.min.x) / 2 - 0.05, (ySill + yTop) / 2 - 0.04, (zFront + zRear) / 2 - 0.2),
      size: new THREE.Vector3(cabinW * 0.78, (yTop - ySill) * 0.9, len + 0.9),
    },
  };
  cache.set(key, cut);
  return cut;
}

/** dark, slightly lit interior: seen only from inside (back faces), so it never shows through the shell */
let cabinMat: THREE.MeshStandardMaterial | null = null;
export function cabinMaterial() {
  return (cabinMat ??= new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9, side: THREE.BackSide, emissive: 0x050608 }));
}
