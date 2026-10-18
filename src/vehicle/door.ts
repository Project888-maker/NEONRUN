// The car models are one solid shell, so there is no door to open: the courier used to climb in and out
// straight through the bodywork. This cuts the driver's door out of the shell, hinges it at its front
// edge, and shows the inside of the shell (dark) through the opening while it is open.
//
// The door is the near-side bodywork inside a box (front wheel arch to the B-pillar, sill to just under
// the roof). Triangles crossing the box are split exactly on its faces, so both the door and the
// opening have clean straight edges like real panel gaps (picking whole triangles left torn edges).
import * as THREE from 'three';

export interface DoorCut {
  /** the shell without the door */
  rest: THREE.BufferGeometry;
  /** the door panel, in car space (place it under a pivot at `hinge`, offset by -hinge) */
  door: THREE.BufferGeometry;
  hinge: THREE.Vector3;
}

const cache = new Map<string, DoorCut | null>();

type Poly = number[][]; // each vertex: all attribute components concatenated

/**
 * @param geo body shell in car space (+z forward, driver side +x, ground at y = 0)
 * @param frontZ z of the front axle, @param rearZ z of the rear axle, @param r wheel radius
 */
export function cutDoor(geo: THREE.BufferGeometry, frontZ: number, rearZ: number, r: number, key = geo.uuid): DoorCut | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const zFront = frontZ - r - 0.12;
  const len = THREE.MathUtils.clamp((zFront - (rearZ + r)) * 0.55, 0.9, 1.25);
  const zRear = zFront - len;
  const ySill = Math.max(bb.min.y + 0.08, r * 0.85);
  const yTop = bb.min.y + (bb.max.y - bb.min.y) * 0.84;
  const xMin = bb.max.x * 0.4;

  // flatten every attribute into one float list per vertex so splits interpolate all of them
  const names = Object.keys(geo.attributes);
  const attrs = names.map((n) => geo.attributes[n] as THREE.BufferAttribute);
  const sizes = attrs.map((a) => a.itemSize);
  const posOff = names.indexOf('position') === 0 ? 0 : sizes.slice(0, names.indexOf('position')).reduce((a, b) => a + b, 0);
  const vert = (i: number) => {
    const v: number[] = [];
    for (const a of attrs) for (let k = 0; k < a.itemSize; k++) v.push(a.getComponent(i, k));
    return v;
  };
  const index = geo.index ? (geo.index.array as ArrayLike<number>) : null;
  const tris = index ? index.length / 3 : geo.attributes.position.count / 3;
  const vi = (t: number, k: number) => (index ? index[t * 3 + k] : t * 3 + k);

  const lerp = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);
  /** split a convex polygon by the plane value(v) = 0 into the part where value >= 0 and the rest */
  const split = (poly: Poly, value: (v: number[]) => number): [Poly, Poly] => {
    const inside: Poly = [], outside: Poly = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = value(a), db = value(b);
      if (da >= 0) inside.push(a); else outside.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const m = lerp(a, b, da / (da - db));
        inside.push(m); outside.push(m);
      }
    }
    return [inside, outside];
  };
  const planes: ((v: number[]) => number)[] = [
    (v) => zFront - v[posOff + 2], (v) => v[posOff + 2] - zRear,
    (v) => v[posOff + 1] - ySill, (v) => yTop - v[posOff + 1],
  ];
  const restOut: number[] = [], doorOut: number[] = [];
  const emit = (poly: Poly, out: number[]) => {
    for (let i = 1; i + 1 < poly.length; i++) for (const v of [poly[0], poly[i], poly[i + 1]]) out.push(...v);
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let t = 0; t < tris; t++) {
    const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    n.subVectors(c, b).cross(e.subVectors(a, b)).normalize();
    const cx = (a.x + b.x + c.x) / 3;
    const tri: Poly = [vert(i0), vert(i1), vert(i2)];
    // only the outer skin of the near side can be door
    if (cx < xMin || n.x < 0.05) { emit(tri, restOut); continue; }
    let inside = tri;
    for (const p of planes) {
      if (inside.length < 3) break;
      const [inn, out] = split(inside, p);
      if (out.length >= 3) emit(out, restOut);
      inside = inn;
    }
    if (inside.length >= 3) emit(inside, doorOut);
  }
  const stride = sizes.reduce((x, y) => x + y, 0);
  // too little to be a door (odd model): leave the car alone
  if (doorOut.length / stride < 3 * 40) { cache.set(key, null); return null; }
  const build = (data: number[]) => {
    const g = new THREE.BufferGeometry();
    const count = data.length / stride;
    let off = 0;
    for (let k = 0; k < names.length; k++) {
      const arr = new Float32Array(count * sizes[k]);
      for (let i = 0; i < count; i++) for (let j = 0; j < sizes[k]; j++) arr[i * sizes[k] + j] = data[i * stride + off + j];
      g.setAttribute(names[k], new THREE.BufferAttribute(arr, sizes[k]));
      off += sizes[k];
    }
    g.computeBoundingSphere();
    return g;
  };
  const door = build(doorOut);
  door.computeBoundingBox();
  // hinge on the door's front edge, at its outermost point
  const hinge = new THREE.Vector3(door.boundingBox!.max.x, 0, zFront);
  const cut: DoorCut = { rest: build(restOut), door, hinge };
  cache.set(key, cut);
  return cut;
}

/**
 * The inside of the shell, drawn dark: only back faces render, and those are hidden behind the outer
 * skin everywhere except through the open door, where it reads as a dim cabin.
 */
let cabinMat: THREE.MeshStandardMaterial | null = null;
export function cabinMaterial() {
  return (cabinMat ??= new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.95, side: THREE.BackSide }));
}
