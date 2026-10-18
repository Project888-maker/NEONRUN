// People on the sidewalk don't walk through each other or the courier: walkers keep to their side, step
// around anyone standing or coming the other way, and slow down behind someone going their way.
import * as THREE from 'three';
const g = globalThis as any;
g.document ??= { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(_v: unknown) {} }), width: 0, height: 0 }) };
const { Crowd } = await import('../src/world/people');
const { plinthRects } = await import('../src/world/layout');

const walkRects = plinthRects().map((r) => ({ ...r, hw: r.hw - 1.4, hd: r.hd - 1.4 }));
const crowd = new Crowd({}, { walkRects, rects: [] } as any, 0) as any;
const stub = () => ({ yaw: 0, currentName: 'walk', root: { position: new THREE.Vector3() }, play(n: string) { this.currentName = n; }, place(x: number, y: number, z: number, yaw: number) { this.root.position.set(x, y, z); this.yaw = yaw; }, update() {}, gaitRate: () => 1, has: () => true });
const R = 40;
// along the first edge (s in 0..W): a head-on pair, a same-way pair, someone standing on the line
const mk = (s: number, dir: 1 | -1, state = 'walk', speed = 1.4) => {
  const ped = { p: stub(), type: 'ped_worker', rect: R, s, dir, speed, state, t: state === 'walk' ? 1e9 : 1e9, pos: new THREE.Vector3(), vel: new THREE.Vector3(), id: crowd.nextId++ };
  crowd.perim(R, s, ped.pos);
  crowd.peds.push(ped);
  return ped;
};
mk(8, 1); mk(34, -1); // head-on, meeting around 21 m
mk(4, 1, 'walk', 1.5); mk(6, 1, 'walk', 1.1); // the faster one catches up
mk(26, 1, 'idle'); // standing on the line, checking a phone
mk(30, -1, 'phone');
const player = new THREE.Vector3(); crowd.perim(R, 18, player); // the courier stands on the line too

let minPair = Infinity, minPlayer = Infinity, moved = 0;
const start = crowd.peds.map((p: any) => p.s);
for (let i = 0; i < 30 * 20; i++) {
  crowd.update(1 / 30, player, null);
  const push = crowd.shoveFrom(player);
  player.add(push);
  const ps = crowd.peds;
  for (let a = 0; a < ps.length; a++) {
    minPlayer = Math.min(minPlayer, Math.hypot(ps[a].pos.x - player.x, ps[a].pos.z - player.z));
    for (let b = a + 1; b < ps.length; b++) minPair = Math.min(minPair, Math.hypot(ps[a].pos.x - ps[b].pos.x, ps[a].pos.z - ps[b].pos.z));
  }
}
crowd.peds.forEach((p: any, i: number) => { if (p.state === 'walk' && Math.abs(p.s - start[i]) > 10) moved++; });
console.log(`closest two people got: ${minPair.toFixed(2)} m, closest to the courier: ${minPlayer.toFixed(2)} m, walkers that kept going: ${moved}/4`);
// centres 0.5+ m apart = shoulders not inside each other
if (minPair < 0.5 || minPlayer < 0.55 || moved < 4) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
