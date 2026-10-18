// Security drones: a car driving away at speed must escape (drone gives up), a stopped car gets
// struck only after a visible lock-on, and a struck drone backs off instead of hitting again at once.
import * as THREE from 'three';
import { Drone } from '../src/world/ambient';

const dt = 1 / 60;
const fail = (m: string) => { console.error('FAIL', m); process.exit(1); };

// 1) escape: player passes 30 m from the post at 30 m/s (108 km/h) and keeps going
{
  const d = new Drone();
  d.mesh.position.set(0, 26, 0);
  const pos = new THREE.Vector3(-150, 0.5, 30), vel = new THREE.Vector3(30, 0, 0);
  let strikes = 0, chased = false;
  for (let i = 0; i < 60 * 30; i++) {
    pos.addScaledVector(vel, dt);
    if (d.update(dt, pos, vel, i * dt)) strikes++;
    if (d.state === 'chase') chased = true;
  }
  console.log('escape: chased', chased, 'strikes', strikes, 'final state', d.state, 'gap', d.mesh.position.distanceTo(pos).toFixed(0));
  if (!chased) fail('drone never noticed a car passing its post');
  if (strikes > 0) fail('drone struck a car driving away at 30 m/s');
  if (d.state === 'chase') fail('drone still chasing after being outrun');
}

// 2) lock-on: a stopped car near the post is struck, but not instantly and not repeatedly
{
  const d = new Drone();
  d.mesh.position.set(0, 26, 0);
  const pos = new THREE.Vector3(20, 0.5, 10), vel = new THREE.Vector3();
  const hits: number[] = [];
  for (let i = 0; i < 60 * 20; i++) if (d.update(dt, pos, vel, i * dt)) hits.push(i * dt);
  console.log('stopped: strikes at', hits.map((h) => h.toFixed(1)).join(', '));
  if (!hits.length) fail('drone never struck a stopped car');
  if (hits[0] < 2) fail('strike came too fast to react');
  for (let i = 1; i < hits.length; i++) if (hits[i] - hits[i - 1] < 6) fail('drone struck again without backing off');
}

// 3) a runner on foot (4.4 m/s) can be caught: the drone is not useless, just escapable by car
{
  const d = new Drone();
  d.mesh.position.set(0, 26, 0);
  const pos = new THREE.Vector3(30, 0, 0), vel = new THREE.Vector3(4.4, 0, 0);
  let hit = false;
  for (let i = 0; i < 60 * 20 && !hit; i++) { pos.addScaledVector(vel, dt); hit = d.update(dt, pos, vel, i * dt); }
  console.log('runner: struck', hit);
  if (!hit) fail('drone could not catch a runner');
}
console.log('PASS');
