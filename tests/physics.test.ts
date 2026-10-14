// Headless driving-model test: run with `npx tsx tests/physics.test.ts`
import * as THREE from 'three';
import { Physics } from '../src/core/physics';
import { Vehicle, type VehicleInput } from '../src/vehicle/vehicle';

const phys = await Physics.init();
const v = new Vehicle(phys, new THREE.Vector3(0, 0.6, 0), 0);
const dt = 1 / 60;
const run = (sec: number, inp: Partial<VehicleInput>, label: string, every = 1) => {
  for (let i = 0; i < sec * 60; i++) {
    v.step(dt, { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...inp });
    phys.world.step();
    if ((i + 1) % Math.round(60 * every) === 0) {
      const t = v.body.translation();
      const contacts = v.wheels.map((w) => (w.contact ? w.compression.toFixed(2) : '--')).join(' ');
      console.log(`${label} t=${((i + 1) / 60).toFixed(1)} kmh=${(v.speed * 3.6).toFixed(1)} pos=(${t.x.toFixed(1)},${t.y.toFixed(2)},${t.z.toFixed(1)}) yaw=${v.yaw().toFixed(2)} drift=${v.drifting} slip=${v.driftAngle.toFixed(2)} wheels[${contacts}] gear=${v.gear} rpm=${v.rpm.toFixed(0)}`);
    }
  }
};
run(1, {}, 'settle');
run(6, { throttle: 1 }, 'accel');
run(3, { throttle: 1, boost: true }, 'boost');
run(2, { throttle: 1, steer: 1 }, 'turn');
run(3, { brake: 1 }, 'slow');
run(2, { throttle: 0.6 }, 'cruise');
run(0.8, { throttle: 1, steer: 1, handbrake: true }, 'hbrake', 0.2);
run(2.5, { throttle: 1, steer: 0.5 }, 'hold', 0.25);
run(1.5, { throttle: 0.7, steer: -0.3 }, 'exit', 0.25);
run(3, { brake: 1 }, 'brake');
run(3, { brake: 1 }, 'reverse');
