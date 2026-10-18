// Dev-only test page (npx vite, then /tests/cars/?ids=hero,car_taxi): every car from the driver's side
// (door shut and open), three-quarter front and rear, under neutral studio light, to check the meshes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CarVisual } from '../../src/vehicle/carVisual';
import { bakeCar, CAR_DEFS, type CarSpec } from '../../src/vehicle/carModels';
const q = new URLSearchParams(location.search);
const ids = (q.get('ids') ?? ['hero', ...CAR_DEFS.map((d) => d.id)].join(',')).split(',');
const lod = q.has('lod');
const W = 360, H = 220;
const views: [string, number, number, number][] = [['door', Math.PI / 2, 0.25, 0], ['open', Math.PI / 2, 0.25, 1], ['front', Math.PI / 4, 0.35, 0], ['rear', Math.PI * 0.8, 0.3, 0]];
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W * views.length, H * ids.length);
renderer.setScissorTest(true);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const pm = new THREE.PMREMGenerator(renderer);
const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2c32);
scene.environment = env;
scene.add(new THREE.HemisphereLight(0xffffff, 0x303038, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(3, 6, 4); scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3a3c42, roughness: 0.9 }));
scene.add(ground);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const kit = await loader.loadAsync('/assets/models/citykit.glb');
const cam = new THREE.PerspectiveCamera(35, W / H, 0.1, 200);
for (const [row, id] of ids.entries()) {
  let c: CarVisual;
  if (id === 'hero') c = new CarVisual(await loader.loadAsync('/assets/models/hero_car.glb'), kit, env);
  else {
    const spec = (await (await fetch(`/assets/cars/${id}.json`)).json()) as CarSpec;
    c = new CarVisual(null, kit, env, bakeCar(await loader.loadAsync(`/assets/cars/${id}${lod ? '_lod' : ''}.glb`), spec));
  }
  c.root.position.set(row * 20, 0, 0);
  scene.add(c.root);
  for (const [col, [, yaw, pitch, open]] of views.entries()) {
    c.doorOpen = open;
    (c as unknown as { doorK: number }).doorK = open;
    if (c.door) c.door.rotation.y = -open * 1.15;
    const d = 7.5;
    cam.position.set(row * 20 + Math.sin(yaw) * d * Math.cos(pitch), 0.8 + Math.sin(pitch) * d, Math.cos(yaw) * d * Math.cos(pitch));
    cam.lookAt(row * 20, 0.7, 0);
    const y = (ids.length - 1 - row) * H;
    renderer.setViewport(col * W, y, W, H); renderer.setScissor(col * W, y, W, H);
    renderer.render(scene, cam);
  }
  c.root.visible = false;
}
(window as { done?: boolean }).done = true;
