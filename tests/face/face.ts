// Dev-only test page (npx vite, then /tests/face/?types=ped_punk,hero&debug): renders each person's
// face up close with the jaw shut and open, to tune the procedural mouth in people.ts.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
const q = new URLSearchParams(location.search);
(globalThis as { __faceDebug?: boolean }).__faceDebug = q.has('debug');
const { Person } = await import('../../src/world/people');
const types = (q.get('types') ?? 'hero,ped_punk,ped_nurse,ped_elder').split(',');
const lines = q.get('lines')?.split(',').map(Number) ?? null;
const opens = lines ? lines.map(() => 0) : (q.get('open') ?? '0,1').split(',').map(Number);
const side = +(q.get('side') ?? 0);
const S = 300;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(S * opens.length, S * types.length);
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202228);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.5); key.position.set(1, 2, 3); scene.add(key);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
for (const [row, type] of types.entries()) {
  const gltf = await loader.loadAsync(`/assets/people/${type}.glb`);
  const p = new Person(gltf, type);
  scene.add(p.root);
  p.place(row * 3, 0, 0, 0);
  p.play('idle', { fade: 0 });
  const head = new THREE.Vector3();
  for (const [col, open] of opens.entries()) {
    p.mouthLevel = open;
    if (lines) p.root.traverse((o) => { const fu = ((o as THREE.Mesh).material as THREE.Material | undefined)?.userData?.faceUniforms; if (fu) fu.uFaceLine.value = lines[col]; });
    for (let i = 0; i < 30; i++) p.update(1 / 30, false);
    p.mixer.setTime(0); p.root.updateMatrixWorld(true);
    p.root.traverse((o) => { if (/^head$/i.test(o.name)) o.getWorldPosition(head); });
    const at = head.clone().add(new THREE.Vector3(0, 0.07, 0));
    cam.position.copy(at).add(new THREE.Vector3(Math.sin(side), 0, Math.cos(side)).multiplyScalar(+(q.get('dist') ?? 0.7)));
    cam.lookAt(at);
    const y = (types.length - 1 - row) * S;
    renderer.setViewport(col * S, y, S, S); renderer.setScissor(col * S, y, S, S);
    renderer.render(scene, cam);
  }
}
(window as { done?: boolean }).done = true;
