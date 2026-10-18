// Dev-only test page (npx vite, then /tests/motion/?type=ped_nurse&clips=walk,run): each clip from the
// side at evenly spaced moments, to check retargeted motion capture.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
const { Person } = await import('../../src/world/people');
const q = new URLSearchParams(location.search);
const type = q.get('type') ?? 'hero';
const clips = (q.get('clips') ?? 'walk,run,idle,talk').split(',');
const N = +(q.get('n') ?? 6), side = +(q.get('side') ?? Math.PI / 2);
const S = +(q.get("size") ?? 220);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(S * N, S * 1.5 * clips.length);
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x24262c);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.4));
const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(2, 3, 2); scene.add(key);
const grid = new THREE.GridHelper(10, 20, 0x555555, 0x333333); scene.add(grid);
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`/assets/people/${type}.glb`);
const p = new Person(gltf, type);
scene.add(p.root);
const cam = new THREE.PerspectiveCamera(32, 1 / 1.5, 0.1, 50);
console.log('gait', JSON.stringify(p.gait), 'clips', gltf.animations.map((c) => `${c.name}:${c.duration.toFixed(2)}`).join(' '));
for (const [row, name] of clips.entries()) {
  const d = p.play(name as never, { fade: 0, restart: true });
  for (let col = 0; col < N; col++) {
    p.current!.time = (d * col) / N;
    p.mixer.update(0);
    p.place(0, 0, 0, 0);
    p.update(0, true);
    cam.position.set(Math.sin(side) * 4.2, 1.0, Math.cos(side) * 4.2);
    cam.lookAt(0, 0.9, 0);
    const y = (clips.length - 1 - row) * S * 1.5;
    renderer.setViewport(col * S, y, S, S * 1.5); renderer.setScissor(col * S, y, S, S * 1.5);
    renderer.render(scene, cam);
  }
}
(window as { done?: boolean }).done = true;
