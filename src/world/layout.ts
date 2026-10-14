// City layout: a 16x16 block grid split into four districts, plus the road graph
// used by traffic AI and GPS routing.

export const GRID = 16;
export const PITCH = 96; // distance between road centerlines (m)
export const ROAD_W = 14; // carriageway width (4 lanes x 3.5 m)
export const SIDEWALK = 3;
export const HALF = (GRID * PITCH) / 2; // 768
export const CURB_H = 0.15;
export const ALLEY_W = 9;

export type DistrictId = 'neon' | 'downtown' | 'backstreets' | 'docks';

export interface DistrictInfo {
  id: DistrictId;
  name: string;
  order: number;
  color: string;
  facades: string[];
  hMin: number;
  hMax: number;
  fog: number; // relative fog density
}

export const DISTRICTS: Record<DistrictId, DistrictInfo> = {
  neon: { id: 'neon', name: 'Neon District', order: 0, color: '#ff2fb4', facades: ['apartment', 'megablock', 'tenement'], hMin: 22, hMax: 95, fog: 1 },
  backstreets: { id: 'backstreets', name: 'Backstreets', order: 1, color: '#ffb347', facades: ['tenement', 'apartment', 'industrial'], hMin: 12, hMax: 34, fog: 1.25 },
  downtown: { id: 'downtown', name: 'Downtown Towers', order: 2, color: '#2ff3ff', facades: ['office_glass', 'tower_lux', 'megablock'], hMin: 55, hMax: 240, fog: 0.85 },
  docks: { id: 'docks', name: 'Industrial Docks', order: 3, color: '#ff8a2a', facades: ['industrial'], hMin: 8, hMax: 18, fog: 1.8 },
};
export const DISTRICT_ORDER: DistrictId[] = ['neon', 'backstreets', 'downtown', 'docks'];

/** Road centerline coordinate for grid line index 0..GRID */
export const lineCoord = (i: number) => -HALF + i * PITCH;
/** Block center coordinate for block index 0..GRID-1 */
export const blockCenter = (i: number) => -HALF + PITCH / 2 + i * PITCH;

export function districtAt(x: number, z: number): DistrictId {
  if (x < 0 && z < 0) return 'neon';
  if (x >= 0 && z < 0) return 'downtown';
  if (x < 0 && z >= 0) return 'backstreets';
  return 'docks';
}
export function districtOfBlock(bi: number, bj: number): DistrictId {
  return districtAt(blockCenter(bi), blockCenter(bj));
}

/** Elevated rail runs along this z road line across the whole map. */
export const RAIL_Z = lineCoord(5);
export const RAIL_H = 13;

// ---------------- Road graph ----------------
export interface GNode { id: number; x: number; z: number; edges: number[]; alley?: boolean }
export interface GEdge { id: number; a: number; b: number; len: number; alley: boolean }

export class RoadGraph {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  private key = new Map<string, number>();

  node(x: number, z: number, alley = false) {
    const k = `${Math.round(x)},${Math.round(z)}`;
    let id = this.key.get(k);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push({ id, x, z, edges: [], alley });
      this.key.set(k, id);
    }
    return id;
  }
  link(a: number, b: number, alley = false) {
    const A = this.nodes[a], B = this.nodes[b];
    const e: GEdge = { id: this.edges.length, a, b, len: Math.hypot(A.x - B.x, A.z - B.z), alley };
    this.edges.push(e);
    A.edges.push(e.id);
    B.edges.push(e.id);
  }
  other(e: GEdge, n: number) { return e.a === n ? e.b : e.a; }

  nearestNode(x: number, z: number, includeAlleys = true) {
    let best = 0, bd = Infinity;
    for (const n of this.nodes) {
      if (!includeAlleys && n.alley) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  }

  /** A* shortest path, returns node ids. */
  route(from: number, to: number, blocked?: (e: GEdge) => boolean): number[] {
    const N = this.nodes;
    const g = new Float64Array(N.length).fill(Infinity);
    const prev = new Int32Array(N.length).fill(-1);
    const open = new Set<number>([from]);
    const h = (i: number) => Math.abs(N[i].x - N[to].x) + Math.abs(N[i].z - N[to].z);
    g[from] = 0;
    const f = new Map<number, number>([[from, h(from)]]);
    while (open.size) {
      let cur = -1, cf = Infinity;
      for (const o of open) { const v = f.get(o)!; if (v < cf) { cf = v; cur = o; } }
      if (cur === to) break;
      open.delete(cur);
      for (const eid of N[cur].edges) {
        const e = this.edges[eid];
        if (blocked && blocked(e)) continue;
        const nb = this.other(e, cur);
        const ng = g[cur] + e.len * (e.alley ? 1.3 : 1);
        if (ng < g[nb]) { g[nb] = ng; prev[nb] = cur; f.set(nb, ng + h(nb)); open.add(nb); }
      }
    }
    const path: number[] = [];
    if (prev[to] === -1 && from !== to) return path;
    for (let c = to; c !== -1; c = prev[c]) path.unshift(c);
    return path;
  }
}

export function buildRoadGraph(): RoadGraph {
  const g = new RoadGraph();
  for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) g.node(lineCoord(i), lineCoord(j));
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      const x = lineCoord(i), z = lineCoord(j);
      // vertical road (along z) from (i,j) to (i,j+1); split at alley midpoints in backstreets
      if (j < GRID) {
        const zMid = z + PITCH / 2;
        const leftAlley = i > 0 && districtOfBlock(i - 1, j) === 'backstreets';
        const rightAlley = i < GRID && districtOfBlock(i, j) === 'backstreets';
        if (leftAlley || rightAlley) {
          const m = g.node(x, zMid);
          g.link(g.node(x, z), m);
          g.link(m, g.node(x, z + PITCH));
        } else g.link(g.node(x, z), g.node(x, z + PITCH));
      }
      if (i < GRID) g.link(g.node(x, z), g.node(x + PITCH, z));
    }
  }
  // alleys through backstreet blocks along x at block-center z
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
    if (districtOfBlock(i, j) !== 'backstreets') continue;
    const zc = blockCenter(j);
    const a = g.node(lineCoord(i), zc), b = g.node(lineCoord(i + 1), zc);
    g.link(a, b, true);
  }
  return g;
}

/** Barrier positions blocking entry into a locked district. Each: x,z,rotY(along road) */
export function districtGates(d: DistrictId): { x: number; z: number; rot: number }[] {
  const out: { x: number; z: number; rot: number }[] = [];
  const off = ROAD_W / 2 + SIDEWALK + 1; // just inside the district
  const inX = (x: number) => (d === 'downtown' || d === 'docks' ? x > 0 : x < 0);
  const inZ = (z: number) => (d === 'backstreets' || d === 'docks' ? z > 0 : z < 0);
  const sx = d === 'downtown' || d === 'docks' ? 1 : -1;
  const sz = d === 'backstreets' || d === 'docks' ? 1 : -1;
  // roads along x crossing the x=0 boundary
  for (let j = 0; j <= GRID; j++) {
    const z = lineCoord(j);
    if (!inZ(z) || Math.abs(z) < 1 || Math.abs(z) === HALF) continue;
    out.push({ x: sx * off, z, rot: Math.PI / 2 });
  }
  for (let j = 0; j < GRID; j++) {
    const z = blockCenter(j);
    if (d === 'backstreets' && inZ(z)) out.push({ x: sx * off, z, rot: Math.PI / 2 }); // alleys
  }
  // roads along z crossing the z=0 boundary
  for (let i = 0; i <= GRID; i++) {
    const x = lineCoord(i);
    if (!inX(x) || Math.abs(x) < 1 || Math.abs(x) === HALF) continue;
    out.push({ x, z: sz * off, rot: 0 });
  }
  // outer ring roads entering the quadrant
  out.push({ x: sx * off, z: sz * HALF, rot: Math.PI / 2 });
  out.push({ x: sx * HALF, z: sz * off, rot: 0 });
  return out;
}
