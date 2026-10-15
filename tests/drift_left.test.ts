// Reproduce the scripted drift from scripts/shots.mjs: accel 3.5s, handbrake+steer 1.2s, hold 1.2s
import * as THREE from 'three';
import { Physics } from '../src/core/physics';
import { Vehicle, type VehicleInput } from '../src/vehicle/vehicle';
const phys = await Physics.init();
const v = new Vehicle(phys, new THREE.Vector3(0, 0.6, 0), 0);
const run = (sec: number, inp: Partial<VehicleInput>, label: string) => {
  for (let i = 0; i < Math.round(sec * 60); i++) {
    v.step(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...inp });
    phys.world.step();
    if ((i + 1) % 15 === 0) console.log(label, ((i + 1) / 60).toFixed(2), 'kmh', (v.speed * 3.6).toFixed(0), 'yaw', v.yaw().toFixed(2), 'slide', v.driftAngle.toFixed(2), 'drift', v.drifting);
  }
};
run(3.5, { throttle: 1 }, 'accel');
run(1.2, { throttle: 1, steer: -0.8, handbrake: true }, 'hb');
run(1.5, { throttle: 1, steer: -0.6 }, 'hold');
run(1.5, { throttle: 1, steer: 0.2 }, 'exit');
