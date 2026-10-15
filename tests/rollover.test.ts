// A hit that tips the car hard and sets it rolling (e.g. a police car shove) should end back on its wheels, not on the roof.
import * as THREE from 'three';
import { Physics } from '../src/core/physics';
import { Vehicle } from '../src/vehicle/vehicle';
const phys = await Physics.init();
let fails = 0;
// these three end on the roof without the anti-rollover assist in vehicle.ts
for (const [roll, spin, label] of [[1.3, 7, 'tipped 75°, fast roll'], [-1.5, -7, 'tipped 86° the other way, fast roll'], [1.7, 4, 'past the side, still rolling']] as const) {
  const v = new Vehicle(phys, new THREE.Vector3(0, 1.6, 0), 0);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);
  v.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  v.body.setAngvel({ x: 0, y: 0, z: spin }, true);
  for (let i = 0; i < 240; i++) { v.step(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false }); phys.world.step(); }
  const r = v.body.rotation();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  const ok = up.y > 0.9;
  if (!ok) fails++;
  console.log(ok ? 'PASS' : 'FAIL', label, 'up.y after 4 s =', up.y.toFixed(2));
  v.dispose();
}
process.exit(fails ? 1 : 0);
