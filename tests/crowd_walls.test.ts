// People running away (or knocked over) must stop at building facades instead of running into them.
import * as THREE from 'three';
const g = globalThis as any;
g.document ??= { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(_v: unknown) {} }), width: 0, height: 0 }) };
const { Crowd } = await import('../src/world/people');
const { plinthRects } = await import('../src/world/layout');

const walkRects = plinthRects().map((r) => ({ ...r, hw: r.hw - 1.4, hd: r.hd - 1.4 }));
const crowd = new Crowd({}, { walkRects } as any, 0);
const keep = (crowd as any).keepOutOfBuildings.bind(crowd);
// facades stand ~1.6 m inside the walking loop (3 m sidewalk, loop 1.4 m from the curb)
const inside = (p: THREE.Vector3) => walkRects.some((r) => Math.abs(p.x - r.x) < r.hw - 1.5 && Math.abs(p.z - r.z) < r.hd - 1.5);

let worst = 0, runs = 0, alongWall = 0;
const r = walkRects[40];
// runners start on the sidewalk loop and flee in every direction, many straight at the building
for (let k = 0; k < 64; k++) {
  const a = (k / 64) * Math.PI * 2;
  const start = new THREE.Vector3(r.x + r.hw, 0, r.z + (k % 8 - 4) * 3);
  const ped: any = { pos: start.clone(), vel: new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(3.4), state: 'flee' };
  let frames = 0;
  for (let i = 0; i < 60 * 4; i++) {
    ped.pos.addScaledVector(ped.vel, 1 / 60);
    keep(ped);
    if (inside(ped.pos)) frames++;
  }
  if (Math.hypot(ped.vel.x, ped.vel.z) > 1) alongWall++;
  worst = Math.max(worst, frames);
  runs++;
}
console.log(`${runs} runners, worst frames inside a building: ${worst}, still running after hitting a wall: ${alongWall}/${runs}`);
if (worst > 0 || alongWall < runs) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
