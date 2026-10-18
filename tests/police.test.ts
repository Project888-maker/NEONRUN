// Police pursuit: cruisers must close in on a stopped player (to box them in) but never drive into the car.
import * as THREE from 'three';
import { Physics } from '../src/core/physics';
import { buildRoadGraph, lineCoord } from '../src/world/layout';
import { Police, offRoad } from '../src/game/police';
import { blockCenter, PITCH, ROAD_W } from '../src/world/layout';
const g = globalThis as any;
g.document ??= { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(_v: unknown) {} }), width: 0, height: 0 }) };
const phys = await Physics.init();
const graph = buildRoadGraph();
const spec = { id: 'car_police', length: 5, width: 2, height: 1.5, wheelRadius: 0.36, wheels: { FL: [0.8, 0.36, 1.5], FR: [-0.8, 0.36, 1.5], RL: [0.8, 0.36, -1.5], RR: [-0.8, 0.36, -1.5] } };
const asset: any = { spec, body: [], wheels: { FL: [], FR: [], RL: [], RR: [] } };
const police = new Police(phys, graph, asset, null);
let busted = 0;
police.onBusted = () => busted++;
const player = new THREE.Vector3(lineCoord(4) + 1.75, 0, -150);
const vel = new THREE.Vector3();
police.add(3, 'test');
let closest = Infinity, t = 0;
const log: string[] = [];
for (let i = 0; i < 60 * 40; i++) {
  const dt = 1 / 60;
  t += dt;
  const r = police.update(dt, t, player, vel, false);
  phys.world.step();
  closest = Math.min(closest, r.nearest);
  if (i % 300 === 0) log.push(`t=${t.toFixed(0)}s units=${police.units.length} dists=[${police.units.map((u) => u.pos.distanceTo(player).toFixed(0)).join(',')}] speeds=[${police.units.map((u) => u.speed.toFixed(1)).join(',')}]`);
}
console.log(log.join('\n'));
const ok1 = closest < 12 && closest > 5.5;
console.log(ok1 ? 'PASS' : 'FAIL', `stopped player: closest cruiser ${closest.toFixed(1)} m (must reach < 12 m, never < 5.5 m), busted ${busted}x`);

// phase 2: the player drives off down the avenue at 14 m/s; cruisers follow but must not touch the car
vel.set(0, 0, -14);
let closestMoving = Infinity, followers = 0;
for (let i = 0; i < 60 * 25; i++) {
  const dt = 1 / 60;
  t += dt;
  player.addScaledVector(vel, dt);
  if (player.z < lineCoord(1)) vel.z = Math.abs(vel.z); else if (player.z > lineCoord(7)) vel.z = -Math.abs(vel.z);
  const r = police.update(dt, t, player, vel, false);
  phys.world.step();
  if (i > 60 * 3) closestMoving = Math.min(closestMoving, r.nearest);
  if (i === 60 * 25 - 1) followers = police.units.filter((u) => u.pos.distanceTo(player) < 60).length;
}
const ok2 = closestMoving > 5.5 && followers > 0;
console.log(ok2 ? 'PASS' : 'FAIL', `moving player: closest cruiser ${closestMoving.toFixed(1)} m (never < 5.5 m), ${followers} still within 60 m after 25 s`);
// phase 3: the player is on foot on a sidewalk, tucked against buildings mid-block (the slot behind them
// would be inside the block). Cruisers must come as close as the road allows, never onto the block.
const blockEdge = blockCenter(4) + (PITCH - ROAD_W) / 2; // east edge of the block
const spots = [new THREE.Vector3(blockEdge - 1.5, 0, blockCenter(2)), new THREE.Vector3(blockCenter(6), 0, blockCenter(3) - (PITCH - ROAD_W) / 2 + 1.5)];
let offRoadFrames = 0, ok3 = true;
for (const spot of spots) {
  player.copy(spot); vel.set(0, 0, 0);
  police.clear(); police.add(3, 'test');
  let near = Infinity;
  for (let i = 0; i < 60 * 30; i++) {
    const dt = 1 / 60;
    t += dt;
    const r = police.update(dt, t, player, vel, true);
    phys.world.step();
    for (const u of police.units) if (offRoad(u.pos.x, u.pos.z, 0.2)) offRoadFrames++;
    if (i > 60 * 5) near = Math.min(near, r.nearest);
  }
  const ok = near < 25;
  ok3 &&= ok;
  console.log(ok ? 'PASS' : 'FAIL', `player on a sidewalk at ${spot.x.toFixed(0)},${spot.z.toFixed(0)}: closest cruiser ${near.toFixed(1)} m (must reach < 25 m)`);
}
const ok4 = offRoadFrames === 0;
console.log(ok4 ? 'PASS' : 'FAIL', `cruiser frames on a block / in a building: ${offRoadFrames} (must be 0)`);
process.exit(ok1 && ok2 && ok3 && ok4 ? 0 : 1);
