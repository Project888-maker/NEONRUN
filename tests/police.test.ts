// Police pursuit: cruisers must close in on a stopped player (to box them in) but never drive into the car.
import * as THREE from 'three';
import { Physics } from '../src/core/physics';
import { buildRoadGraph, lineCoord } from '../src/world/layout';
import { Police } from '../src/game/police';
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
process.exit(ok1 && ok2 ? 0 : 1);
