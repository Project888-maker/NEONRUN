import * as THREE from 'three';
import { Loader, type Assets } from './core/assets';
import { Physics, RAPIER } from './core/physics';
import { Input } from './core/input';
import { qualitySettings, autoDetectQuality, isMobile, type QualityLevel, type QualitySettings } from './core/quality';
import { Post } from './render/post';
import { PlanarReflector, LAYER_NO_REFLECT } from './render/reflector';
import { poolUniforms, MAX_POOLS } from './render/groundMaterial';
import { Sky, createCityEnvMap } from './render/sky';
import { City, type LightSrc } from './world/city';
import { buildRoadGraph, lineCoord, districtAt, HALF, PITCH, GRID, DISTRICTS, DISTRICT_ORDER, RAIL_Z, type DistrictId } from './world/layout';
import { Rain, Splashes, Particles, FogLayers } from './world/weather';
import { Traffic } from './world/traffic';
import { Train, SkyTraffic } from './world/ambient';
import { Vehicle } from './vehicle/vehicle';
import { CarVisual, PAINTS, UNDERGLOW } from './vehicle/carVisual';
import { CAR_DEFS, carDef } from './vehicle/carModels';
import { ChaseCam } from './vehicle/chaseCam';
import { AudioSys } from './audio/audio';
import { Hud } from './game/hud';
import { Missions } from './game/missions';
import { loadSave, writeSave, UPGRADE_COST, UNLOCK_AT, type Save } from './game/progress';

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ renderer
const canvas = $('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setSize(innerWidth, innerHeight);
renderer.info.autoReset = false;
const save: Save = loadSave();
const autoLevel = autoDetectQuality(renderer.getContext() as WebGL2RenderingContext);
let qLevel: QualityLevel = (params.get('q') as QualityLevel) || (save.settings.quality === 'auto' ? autoLevel : save.settings.quality);
let Q: QualitySettings = qualitySettings(qLevel);
renderer.setPixelRatio(Q.pixelRatio);

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0x0b0a18);
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0062);
scene.background = FOG_COLOR;
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.15, 3200);
camera.layers.enable(LAYER_NO_REFLECT);
camera.position.set(0, 5, -10);

const input = new Input();
const audio = new AudioSys();
const hud = new Hud();

// ------------------------------------------------------------------ globals filled during boot
let A: Assets;
let phys: Physics;
let city: City;
let reflector: PlanarReflector;
let post: Post;
let sky: Sky;
let rain: Rain, splashes: Splashes, fogLayers: FogLayers;
let smoke: Particles, sparks: Particles;
let traffic: Traffic;
let train: Train, skyTraffic: SkyTraffic;
let vehicle: Vehicle;
let car: CarVisual;
let chase: ChaseCam;
let missions: Missions;
let eventQueue: RAPIER.EventQueue;
const graph = buildRoadGraph();
const realLights: THREE.PointLight[] = [];
const videos: Record<string, HTMLVideoElement> = {};
let lightGrid = new Map<string, LightSrc[]>();
// live reflection probe for the car paint (High/Med): renders the real neon street into a cube map
let cubeRT: THREE.WebGLCubeRenderTarget | null = null;
let cubeCam: THREE.CubeCamera | null = null;
let cubeFrame = 0;

let state: 'loading' | 'title' | 'playing' | 'paused' = 'loading';
let simTime = 0;
let landmarkMeshes: THREE.Object3D[] = [];

const SPAWN = new THREE.Vector3(lineCoord(4) + 1.75, 0.6, -150);
const SPAWN_YAW = Math.PI;

// ------------------------------------------------------------------ boot
async function boot() {
  const loader = new Loader();
  const fill = $('loadfill'), label = $('loadlabel');
  const setP = (p: number, l: string) => { fill.style.width = `${Math.round(p * 100)}%`; label.textContent = l; };
  loader.onProgress = (p, l) => setP(p * 0.55, `Loading ${l.split('/').pop()}`);
  const [assets, physics] = await Promise.all([loader.loadAll(), Physics.init()]);
  A = assets; phys = physics;
  setP(0.58, 'Decoding audio…');
  await audio.load((p) => setP(0.58 + p * 0.12, 'Decoding audio…'));
  setP(0.72, 'Generating city…');
  await new Promise((r) => setTimeout(r, 30));
  buildWorld();
  setP(0.9, 'Compiling shaders…');
  await new Promise((r) => setTimeout(r, 30));
  renderer.compile(scene, camera);
  setP(1, 'Ready');
  hud.setCredits(save.credits);
  hud.unlocked = save.unlocked;
  showTitle();
  (window as any).__neon = debugApi();
}

function buildWorld() {
  const env = createCityEnvMap(renderer);
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  reflector = new PlanarReflector(0, Q.reflectionScale, Q.reflectionEvery);
  reflector.enabled = Q.reflection;
  reflector.setSize(innerWidth * Q.pixelRatio, innerHeight * Q.pixelRatio);
  const atl = (n: string) => A.tex[n];
  // atlases are loaded lazily here (small json + texture)
  const signTex = new THREE.TextureLoader().load('./assets/atlas/signs.webp');
  const adTex = new THREE.TextureLoader().load('./assets/atlas/ads.webp');
  const shopTex = new THREE.TextureLoader().load('./assets/atlas/shops.webp');
  void atl;
  city = new City(A, phys, { reflector, envMap: env }, { signs: atlasJson.signs, ads: atlasJson.ads, shops: atlasJson.shops, signTex, adTex, shopTex }).build();
  scene.add(city.root);
  // spatial hash for light pool selection
  lightGrid = new Map();
  for (const l of city.lights) {
    const k = `${Math.floor(l.pos.x / 48)},${Math.floor(l.pos.z / 48)}`;
    (lightGrid.get(k) ?? lightGrid.set(k, []).get(k)!).push(l);
  }
  placeLandmarks();

  sky = new Sky(A.tex.sky, A.tex.clouds);
  scene.add(sky.group);
  const hemi = new THREE.HemisphereLight(0x3a3a70, 0x0a0812, 0.55);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x8090c0, 0.35);
  moon.position.set(-0.4, 1, -0.3);
  scene.add(moon);
  for (let i = 0; i < 6; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 30, 2);
    scene.add(l);
    realLights.push(l);
  }

  rain = new Rain(20000);
  rain.mesh.geometry.setDrawRange(0, Q.rainCount * 2);
  splashes = new Splashes(600);
  splashes.mesh.count = Q.splashCount;
  fogLayers = new FogLayers(70);
  smoke = new Particles(900, false);
  sparks = new Particles(500, true);
  scene.add(rain.mesh, splashes.mesh, fogLayers.group, smoke.points, sparks.points);

  traffic = new Traffic(graph, phys, A.kit, 32, (x, z) => {
    const i = Math.round((x + HALF) / PITCH), j = Math.round((z + HALF) / PITCH);
    return Math.abs(lineCoord(i) - x) < 1 && Math.abs(lineCoord(j) - z) < 1 ? [i, j] : null;
  }, CAR_DEFS.filter((d) => A.carsLod[d.id] || A.cars[d.id]).map((d) => ({ asset: A.carsLod[d.id] ?? A.cars[d.id], def: d })), env);
  (traffic as any).count = Q.traffic;
  traffic.onHonk = (p) => audio.play('horn', { pos: p, volume: 0.6, rate: 0.9 + Math.random() * 0.2 });
  scene.add(traffic.group);
  train = new Train(A.kit);
  scene.add(train.group);
  skyTraffic = new SkyTraffic(450);
  scene.add(skyTraffic.points);

  envTex = env;
  if (!A.cars[save.car] && save.car !== 'hero') save.car = 'hero';
  spawnPlayerCar(save.car, SPAWN, SPAWN_YAW);
  cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  cubeCam = new THREE.CubeCamera(0.5, 160, cubeRT);
  cubeCam.children.forEach((c) => { c.layers.enableAll(); c.layers.disable(LAYER_NO_REFLECT); });
  scene.add(cubeCam);
  applyCustomization();
  chase = new ChaseCam(camera, phys);
  chase.mode = save.settings.cam;
  eventQueue = new RAPIER.EventQueue(true);

  post = new Post(renderer, scene, camera, Q);
  post.setSize(innerWidth, innerHeight);
  sparks.setScale(innerHeight * Q.pixelRatio, camera.fov);
  smoke.setScale(innerHeight * Q.pixelRatio, camera.fov);

  missions = new Missions(city, graph, hud, audio, save, {
    onUnlock: (d) => {
      city.unlock(d);
      hud.unlocked = save.unlocked;
      hud.banner(DISTRICTS[d].name, 'District unlocked');
      audio.say('unlock');
      audio.play('ui_confirm');
    },
    onComplete: () => {},
    onNearMiss: () => { vehicle.boost = Math.min(1, vehicle.boost + 0.15); },
  });
  scene.add(missions.group);
  for (const d of save.unlocked) city.unlock(d);

  // video billboards
  for (const clip of new Set(city.videoScreens.map((s) => s.clip))) {
    const v = document.createElement('video');
    v.src = `./assets/video/${clip}.mp4`;
    v.muted = true; v.loop = true; v.playsInline = true; v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    videos[clip] = v;
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (const s of city.videoScreens.filter((q) => q.clip === clip)) {
      const m = s.mesh.material as THREE.MeshBasicMaterial;
      m.map = tex;
      m.color.setRGB(1.5, 1.5, 1.5);
      m.needsUpdate = true;
    }
  }
}

let atlasJson: { signs: any; ads: any; shops: any };
let envTex: THREE.Texture;

export const HERO_DEF = { id: 'hero', name: 'Night Courier', price: 0, desc: 'Your own muscle coupe. Paint, glow and liveries apply here.', mass: 1450, power: 1, topSpeed: 56, grip: 1, traffic: 0 };

/** Replace the player's car (visual + physics), keeping position/heading/velocity. Used by the garage and car theft. */
function spawnPlayerCar(id: string, pos: THREE.Vector3, yaw: number, vel?: THREE.Vector3) {
  if (car) { car.root.removeFromParent(); }
  if (vehicle) vehicle.dispose();
  const asset = id === 'hero' ? undefined : A.cars[id];
  const def = id === 'hero' ? HERO_DEF : carDef(id)!;
  car = new CarVisual(asset ? null : A.car, A.kit, envTex, asset);
  const wp = Object.fromEntries(Object.entries(car.wheelLocal).map(([k, v]) => [k, v.clone()]));
  vehicle = new Vehicle(phys, pos, yaw, Object.keys(wp).length === 4 ? wp : undefined, {
    mass: def.mass, power: def.power, topSpeed: def.topSpeed, grip: def.grip,
    wheelRadius: asset ? asset.spec.wheelRadius : undefined, dims: car.dims,
  });
  vehicle.upgrades = { ...save.upgrades };
  vehicle.onShift = (g) => { if (state === 'playing' && g > 1) audio.play('gear_shift', { volume: 0.45 }); };
  if (vel) vehicle.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
  scene.add(car.root);
  carId = id;
  if (cubeRT && car.paintMat) { car.paintMat.envMap = cubeRT.texture; car.paintMat.needsUpdate = true; }
}
let carId = 'hero';

function placeLandmarks() {
  const fit = (id: string, target: number, by: 'height' | 'width') => {
    const g = A.landmarks[id];
    if (!g) return null;
    const o = g.scene.clone(true);
    const box = new THREE.Box3().setFromObject(o);
    const size = box.getSize(new THREE.Vector3());
    const s = target / (by === 'height' ? size.y : Math.max(size.x, size.z));
    o.scale.setScalar(s);
    o.position.y = -box.min.y * s;
    const wrap = new THREE.Group();
    wrap.add(o);
    o.position.x = -((box.min.x + box.max.x) / 2) * s;
    o.position.z = -((box.min.z + box.max.z) / 2) * s;
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.map && !mat.userData.glow) {
        mat.userData.glow = true;
        mat.emissiveMap = mat.map;
        mat.emissive = new THREE.Color(1, 1, 1);
        mat.emissiveIntensity = 1;
        mat.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `
            #ifdef USE_EMISSIVEMAP
              vec4 emissiveColor = texture2D(emissiveMap, vEmissiveMapUv);
              float mx = max(emissiveColor.r, max(emissiveColor.g, emissiveColor.b));
              float mn = min(emissiveColor.r, min(emissiveColor.g, emissiveColor.b));
              float sat = (mx - mn) / max(mx, 1e-3);
              totalEmissiveRadiance *= emissiveColor.rgb * smoothstep(0.45, 0.8, mx) * smoothstep(0.35, 0.7, sat) * 5.0;
            #endif`);
        };
        mat.needsUpdate = true;
      }
    });
    return wrap;
  };
  const used = new Set<string>();
  for (const l of city.landmarkSpots) {
    if (l.id === 'lm_pagoda' && used.has('lm_pagoda_2')) continue;
    if (l.id === 'lm_watertower' && [...used].filter((u) => u.startsWith('wt')).length > 8) continue;
    const o = fit(l.id, l.scale, l.id === 'lm_pagoda' ? 'width' : 'height');
    if (!o) continue;
    o.position.add(l.pos);
    o.rotation.y = l.rot;
    city.root.add(o);
    landmarkMeshes.push(o);
    if (l.id === 'lm_pagoda') used.add(used.has('lm_pagoda') ? 'lm_pagoda_2' : 'lm_pagoda');
    if (l.id === 'lm_watertower') used.add(`wt${used.size}`);
    if (l.id === 'lm_statue') {
      phys.cylinder(l.pos.x, 5, l.pos.z, 5, 4);
      city.lights.push({ pos: l.pos.clone().add(new THREE.Vector3(0, 6, 8)), color: new THREE.Color(0.2, 0.9, 1), radius: 26, kind: 'sign' });
    }
    if (l.id === 'lm_crane') phys.box(l.pos.x, 20, l.pos.z, 6, 20, 14);
  }
  // district gate arches over the avenue near the start
  for (const [x, z] of [[lineCoord(4), -220], [lineCoord(2), lineCoord(6) + 48]]) {
    const o = fit('lm_gate', 26, 'width');
    if (!o) continue;
    o.position.set(x, 0, z);
    o.rotation.y = 0;
    city.root.add(o);
    landmarkMeshes.push(o);
    phys.box(x - 11.5, 8, z, 1.0, 8, 1.2);
    phys.box(x + 11.5, 8, z, 1.0, 8, 1.2);
    city.lights.push({ pos: new THREE.Vector3(x, 8, z), color: new THREE.Color(0.9, 0.3, 1), radius: 26, kind: 'sign' });
  }
}

// ------------------------------------------------------------------ menus
function show(id: string, on: boolean) { $(id).classList.toggle('hidden', !on); }
let menuReturn: 'title' | 'pause' = 'title';

function showTitle() {
  state = 'title';
  show('loading', false);
  show('title', true);
  show('hud', false);
  show('touch', false);
  const v = $('intro-video') as HTMLVideoElement;
  v.play().catch(() => {});
  ($('loading-video') as HTMLVideoElement).pause();
  $('build-info').textContent = `quality: ${qLevel}${save.settings.quality === 'auto' ? ' (auto)' : ''}`;
  if (!audio.started) show('tap', true);
  audio.music_('menu');
}

const unlockAudio = async () => {
  await audio.start();
  show('tap', false);
  if (state === 'title') audio.music_('menu');
};
addEventListener('pointerdown', unlockAudio);
addEventListener('keydown', unlockAudio);

document.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
  b.addEventListener('mouseenter', () => audio.play('ui_hover', { volume: 0.25 }));
  b.addEventListener('click', () => {
    audio.play('ui_click', { volume: 0.6 });
    const act = b.dataset.act!;
    if (act === 'play') startDrive();
    if (act === 'garage') openGarage();
    if (act === 'settings') openSettings();
    if (act === 'controls') { show('title', false); show('controls', true); }
    if (act === 'back') { ['garage', 'settings', 'controls'].forEach((s) => show(s, false)); show(menuReturn === 'pause' ? 'pause' : 'title', true); }
    if (act === 'resume') resume();
    if (act === 'quit') quitToTitle();
  });
});

function openGarage() {
  show('title', false); show('pause', false); show('garage', true);
  renderGarage();
}

function renderGarage() {
  $('g-credits').textContent = save.credits.toLocaleString();
  const ups: { key: keyof Save['upgrades']; name: string; icon: string; desc: string }[] = [
    { key: 'speed', name: 'Engine', icon: 'speedometer', desc: 'More power and top speed.' },
    { key: 'grip', name: 'Tires', icon: 'tire', desc: 'More grip in the wet.' },
    { key: 'boost', name: 'Nitro', icon: 'lightning', desc: 'Bigger boost tank.' },
  ];
  $('upgrades').innerHTML = ups.map((u) => {
    const lv = save.upgrades[u.key];
    const cost = UPGRADE_COST[lv];
    return `<div class="card"><div class="c-head"><img src="./assets/icon/${u.icon}.png" alt="">${u.name}</div>
      <div class="pips">${[0, 1, 2].map((i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</div>
      <div class="desc">${u.desc}</div>
      <button data-up="${u.key}" ${lv >= 3 ? 'disabled' : ''}>${lv >= 3 ? 'Maxed' : `Upgrade · ${cost} CR`}</button></div>`;
  }).join('');
  $('upgrades').querySelectorAll<HTMLButtonElement>('button[data-up]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.up as keyof Save['upgrades'];
    const lv = save.upgrades[k];
    if (lv >= 3) return;
    if (save.credits < UPGRADE_COST[lv]) { audio.play('ui_error'); return; }
    save.credits -= UPGRADE_COST[lv];
    save.upgrades[k]++;
    writeSave(save);
    audio.play('cash');
    audio.say('upgrade');
    hud.setCredits(save.credits);
    applyCustomization();
    renderGarage();
  }));
  $('paints').innerHTML = PAINTS.map((p) => `<div class="swatch ${save.paint === p.id ? 'on' : ''}" data-paint="${p.id}" title="${p.name}" style="background:rgb(${p.color.map((c) => Math.min(255, c * 55)).join(',')})"></div>`).join('');
  $('glows').innerHTML = UNDERGLOW.map((c) => `<div class="swatch ${save.underglow === c ? 'on' : ''}" data-glow="${c}" style="background:${c};box-shadow:0 0 14px ${c}"></div>`).join('');
  $('liveries').innerHTML = `<div class="swatch ${!save.livery ? 'on' : ''}" data-liv="" style="display:flex;align-items:center;justify-content:center;font-size:11px;color:#8c9bb8">NONE</div>` +
    Object.keys(A.liveries).map((l) => `<div class="swatch ${save.livery === l ? 'on' : ''}" data-liv="${l}" style="background-image:url(./assets/livery/${l}.png)"></div>`).join('');
  const bar = (v: number, max: number) => `<div class="pips">${[0, 1, 2, 3, 4].map((i) => `<i class="${i < Math.round((v / max) * 5) ? 'on' : ''}"></i>`).join('')}</div>`;
  $('cars').innerHTML = [HERO_DEF, ...CAR_DEFS.filter((d) => A.cars[d.id])].map((d) => {
    const owned = save.ownedCars.includes(d.id), current = save.car === d.id;
    return `<div class="card car-card ${current ? 'current' : ''}"><div class="c-head">${d.name}</div><div class="desc">${d.desc}</div>
      <div class="stat">Speed ${bar(d.topSpeed, 70)}</div><div class="stat">Power ${bar(d.power, 1.45)}</div><div class="stat">Grip ${bar(d.grip, 1.15)}</div>
      <button data-car="${d.id}" ${current ? 'disabled' : ''}>${current ? 'Driving' : owned ? 'Drive' : `Buy · ${d.price.toLocaleString()} CR`}</button></div>`;
  }).join('');
  $('cars').querySelectorAll<HTMLButtonElement>('button[data-car]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.car!;
    const d = id === 'hero' ? HERO_DEF : carDef(id)!;
    if (!save.ownedCars.includes(id)) {
      if (save.credits < d.price) { audio.play('ui_error'); return; }
      save.credits -= d.price;
      save.ownedCars.push(id);
      audio.play('cash');
      hud.setCredits(save.credits);
    }
    save.car = id;
    writeSave(save);
    spawnPlayerCar(id, carPos.clone().setY(0.8), vehicle.yaw());
    applyCustomization();
    renderGarage();
  }));
  $('districts').innerHTML = DISTRICT_ORDER.map((d) => {
    const un = save.unlocked.includes(d);
    const img = { neon: 'card_neon', backstreets: 'card_backstreets', downtown: 'card_downtown', docks: 'card_docks' }[d];
    return `<div class="card ${un ? '' : 'locked'}"><img src="./assets/ui/${img}.webp" alt=""><div class="d-name">${DISTRICTS[d].name}${un ? '' : ` · ${UNLOCK_AT[d]} deliveries`}</div></div>`;
  }).join('');
  const bind = (sel: string, fn: (el: HTMLElement) => void) => document.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener('click', () => { fn(el); writeSave(save); applyCustomization(); audio.play('ui_click', { volume: 0.5 }); renderGarage(); }));
  bind('[data-paint]', (el) => (save.paint = el.dataset.paint!));
  bind('[data-glow]', (el) => (save.underglow = el.dataset.glow!));
  bind('[data-liv]', (el) => (save.livery = el.dataset.liv || null));
}

function applyCustomization() {
  car.setPaint(save.paint);
  car.setUnderglow(save.underglow);
  vehicle.upgrades = { ...save.upgrades };
  // decals need the car's world matrix: place temporarily at origin
  car.root.updateMatrixWorld(true);
  car.setLivery(save.livery ? A.liveries[save.livery] : null);
}

function openSettings() {
  show('title', false); show('pause', false); show('settings', true);
  const segQ = $('q-seg'), segC = $('cam-seg');
  const refresh = () => {
    segQ.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.q === save.settings.quality));
    segC.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.cam === save.settings.cam));
  };
  segQ.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
    save.settings.quality = b.dataset.q as any;
    writeSave(save);
    setQuality(save.settings.quality === 'auto' ? autoLevel : (save.settings.quality as QualityLevel));
    refresh();
  }));
  segC.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { save.settings.cam = b.dataset.cam as any; chase.mode = save.settings.cam; writeSave(save); refresh(); }));
  for (const k of ['master', 'music', 'sfx'] as const) {
    const el = $(`v-${k}`) as HTMLInputElement;
    el.value = String(save.settings[k]);
    el.oninput = () => { save.settings[k] = +el.value; audio.setVolumes({ [k]: +el.value }); writeSave(save); };
  }
  refresh();
}

/** Apply quality settings live (no reload needed). */
function setQuality(l: QualityLevel) {
  qLevel = l;
  Q = qualitySettings(l);
  renderer.setPixelRatio(Q.pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
  reflector.scale = Q.reflectionScale;
  reflector.every = Q.reflectionEvery;
  reflector.setSize(innerWidth * Q.pixelRatio, innerHeight * Q.pixelRatio);
  if (post.ao) post.ao.enabled = Q.ao;
  rain.mesh.geometry.setDrawRange(0, Q.rainCount * 2);
  splashes.mesh.count = Q.splashCount;
  (traffic as any).count = Q.traffic;
  sparks.setScale(innerHeight * Q.pixelRatio, camera.fov);
  smoke.setScale(innerHeight * Q.pixelRatio, camera.fov);
}

function startDrive() {
  show('title', false);
  show('tap', false);
  ($('intro-video') as HTMLVideoElement).pause();
  show('hud', true);
  hud.show(true);
  if (isMobile() || params.has('touch')) { show('touch', true); document.body.classList.add('touch'); }
  audio.setVolumes({ master: save.settings.master, music: save.settings.music, sfx: save.settings.sfx });
  audio.startDriving();
  audio.music_('chill');
  Object.values(videos).forEach((v) => v.play().catch(() => {}));
  state = 'playing';
  menuReturn = 'pause';
  if (!missions.target || missions.state === 'results') missions.newJob(carPos);
  else missions.newJob(carPos);
  hud.banner(DISTRICTS[districtAt(carPos.x, carPos.z)].name, 'Night shift');
  perf.reset();
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  show('pause', true);
  audio.ctx.suspend();
}
function resume() {
  show('pause', false);
  ['garage', 'settings', 'controls'].forEach((s) => show(s, false));
  state = 'playing';
  audio.ctx.resume();
}
function quitToTitle() {
  show('pause', false);
  audio.ctx.resume();
  showTitle();
}

// ------------------------------------------------------------------ touch controls
function setupTouch() {
  const steer = $('t-steer'), knob = $('t-knob');
  let id: number | null = null, x0 = 0;
  steer.addEventListener('pointerdown', (e) => { id = e.pointerId; x0 = e.clientX; knob.style.left = `${e.clientX}px`; knob.style.bottom = `${innerHeight - e.clientY}px`; steer.setPointerCapture(e.pointerId); });
  steer.addEventListener('pointermove', (e) => { if (e.pointerId !== id) return; input.touch.steer = THREE.MathUtils.clamp((e.clientX - x0) / 70, -1, 1); });
  const end = (e: PointerEvent) => { if (e.pointerId !== id) return; id = null; input.touch.steer = 0; };
  steer.addEventListener('pointerup', end);
  steer.addEventListener('pointercancel', end);
  const hold = (el: string, on: () => void, off: () => void) => {
    const b = $(el);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); on(); });
    b.addEventListener('pointerup', off);
    b.addEventListener('pointerleave', off);
    b.addEventListener('pointercancel', off);
  };
  hold('t-gas', () => (input.touch.throttle = 1), () => (input.touch.throttle = 0));
  hold('t-brake', () => (input.touch.brake = 1), () => (input.touch.brake = 0));
  hold('t-drift', () => (input.touch.handbrake = true), () => (input.touch.handbrake = false));
  hold('t-boost', () => (input.touch.boost = true), () => (input.touch.boost = false));
  $('t-pause').addEventListener('click', pause);
}
setupTouch();

// ------------------------------------------------------------------ per-frame helpers
const carPos = SPAWN.clone();
const carQuat = new THREE.Quaternion();
const carVel = new THREE.Vector3();
let poolFrame = 0;
const dynLights: { pos: THREE.Vector3; color: THREE.Color; radius: number }[] = [];

function updateLightPools() {
  if (poolFrame++ % 4 !== 0) return;
  const focus = camera.position.clone().add(new THREE.Vector3(0, 0, -30).applyQuaternion(camera.quaternion)).setY(0);
  const cand: { l: { pos: THREE.Vector3; color: THREE.Color; radius: number }; s: number }[] = [];
  const cx = Math.floor(focus.x / 48), cz = Math.floor(focus.z / 48);
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const arr = lightGrid.get(`${cx + i},${cz + j}`);
    if (!arr) continue;
    for (const l of arr) {
      const d = Math.max(4, l.pos.distanceTo(focus));
      cand.push({ l, s: (l.radius * l.radius) / (d * d) });
    }
  }
  dynLights.length = 0;
  traffic.lightSources(dynLights);
  dynLights.push({ pos: carPos.clone().setY(0.4), color: car.underglowColor.clone().multiplyScalar(1.6), radius: 6 });
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
  dynLights.push({ pos: carPos.clone().addScaledVector(fwd, 9).setY(1.2), color: new THREE.Color(0.95, 0.97, 1).multiplyScalar(1.3), radius: 14 });
  if (vehicle.braking) dynLights.push({ pos: carPos.clone().addScaledVector(fwd, -3).setY(0.8), color: new THREE.Color(1, 0, 0), radius: 6 });
  if (missions?.target) dynLights.push({ pos: missions.target.clone().setY(2), color: missions.state === 'toDrop' ? new THREE.Color(1, 0.2, 0.7) : new THREE.Color(0.2, 0.9, 1), radius: 16 });
  for (const l of dynLights) {
    const d = Math.max(4, l.pos.distanceTo(focus));
    cand.push({ l, s: (l.radius * l.radius) / (d * d) * 1.5 });
  }
  cand.sort((a, b) => b.s - a.s);
  const P = poolUniforms.uPoolPos.value, C = poolUniforms.uPoolCol.value;
  for (let i = 0; i < MAX_POOLS; i++) {
    const c = cand[i];
    if (!c) { P[i].set(0, -999, 0, 1); C[i].set(0, 0, 0); continue; }
    P[i].set(c.l.pos.x, c.l.pos.y, c.l.pos.z, c.l.radius);
    C[i].set(c.l.color.r, c.l.color.g, c.l.color.b).multiplyScalar(c.l.radius > 20 ? 0.9 : 1.2);
  }
  // real point lights: strongest static lights near the car (they tint the car paint)
  const near = cand.filter((c) => c.l.pos.distanceTo(carPos) < 28 && !dynLights.includes(c.l as any)).slice(0, Q.realLights);
  realLights.forEach((rl, i) => {
    const c = near[i];
    if (!c) { rl.intensity = 0; return; }
    rl.position.copy(c.l.pos);
    rl.color.copy(c.l.color);
    rl.distance = c.l.radius * 2.2;
    rl.intensity = 60;
  });
}

const perf = {
  frames: 0, acc: 0, samples: [] as number[], checkT: 0, lowered: false,
  reset() { this.frames = 0; this.acc = 0; this.samples = []; this.checkT = 0; },
};

function adaptiveQuality(dt: number) {
  perf.samples.push(dt);
  if (perf.samples.length > 240) perf.samples.shift();
  perf.checkT += dt;
  if (perf.checkT > 5 && save.settings.quality === 'auto' && !params.has('q') && perf.samples.length >= 200) {
    perf.checkT = 0;
    const avg = perf.samples.reduce((a, b) => a + b, 0) / perf.samples.length;
    const fps = 1 / avg;
    if (fps < 38 && qLevel !== 'low') {
      setQuality(qLevel === 'high' ? 'med' : 'low');
      hud.toast(`Quality → ${qLevel} for performance`);
      perf.samples = [];
    }
  }
}

function emitEffects(dt: number) {
  const spd = vehicle.speedAbs;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
  // wet road spray + drift smoke from the rear wheels
  vehicle.wheels.forEach((w, i) => {
    if (!w.contact) return;
    const rear = i >= 2;
    const slip = Math.abs(w.slipLat) + w.slipLong;
    if (spd > 7 && Math.random() < (rear ? 0.9 : 0.4) * Math.min(1, spd / 30)) {
      const v = carVel.clone().multiplyScalar(0.25).add(new THREE.Vector3((Math.random() - 0.5) * 2.5, 1.5 + Math.random() * 2.2, (Math.random() - 0.5) * 2.5)).addScaledVector(fwd, -spd * 0.12);
      smoke.emit(w.contactPoint.clone().add(new THREE.Vector3(0, 0.15, 0)), v, 0.5 + Math.random() * 0.3, 0.45, new THREE.Color(0.55, 0.6, 0.7), 0.22, { grow: 3.5, drag: 1.4, gravity: 3 });
    }
    if (rear && (vehicle.drifting || slip > 0.35) && spd > 5) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2).addScaledVector(carVel, 0.15);
      smoke.emit(w.contactPoint.clone().add(new THREE.Vector3(0, 0.3, 0)), v, 1.6 + Math.random(), 1.0, new THREE.Color(0.7, 0.72, 0.8), 0.28, { grow: 5, drag: 0.8 });
    }
  });
  if (vehicle.boosting) {
    for (const sx of [0.42, -0.42]) {
      const p = new THREE.Vector3(sx, 0.42, -2.6).applyQuaternion(carQuat).add(carPos);
      sparks.emit(p, fwd.clone().multiplyScalar(-8 - Math.random() * 6).add(carVel.clone().multiplyScalar(0.8)).add(new THREE.Vector3((Math.random() - 0.5), Math.random(), (Math.random() - 0.5))), 0.3, 0.18, new THREE.Color(0.3, 0.6, 3), 1, { drag: 2 });
    }
  }
  // steam vents near the camera
  for (const s of city.steam) {
    if (Math.abs(s.x - camera.position.x) > 70 || Math.abs(s.z - camera.position.z) > 70) continue;
    if (Math.random() < dt * 9) smoke.emit(s.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.8)), new THREE.Vector3((Math.random() - 0.5) * 0.6, 2.2 + Math.random() * 1.5, (Math.random() - 0.5) * 0.6), 2.6, 1.3, new THREE.Color(0.65, 0.65, 0.75), 0.2, { grow: 5, drag: 0.35 });
  }
}

function impact(force: number, other: RAPIER.Collider | null) {
  const strength = Math.min(1, force / 400000);
  if (strength < 0.04) return;
  chase.impact(strength * 0.9);
  const isTraffic = other?.parent() && other.parent()!.isKinematic();
  if (isTraffic && other!.parent()) traffic.hit(other!.parent()!);
  const name = strength > 0.45 ? (Math.random() < 0.3 ? 'hit_glass' : 'hit_heavy') : isTraffic ? 'hit_light' : Math.random() < 0.5 ? 'hit_metal' : 'hit_light';
  audio.play(name, { volume: 0.3 + strength * 0.7, rate: 0.9 + Math.random() * 0.2 });
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
  const p = carPos.clone().addScaledVector(fwd, 2).add(new THREE.Vector3(0, 0.6, 0));
  for (let i = 0; i < 10 + strength * 50; i++) {
    sparks.emit(p, new THREE.Vector3((Math.random() - 0.5) * 12, Math.random() * 7, (Math.random() - 0.5) * 12).add(carVel.clone().multiplyScalar(0.4)), 0.3 + Math.random() * 0.5, 0.07, new THREE.Color(4, 1.6, 0.4), 1, { gravity: 14, drag: 0.6 });
  }
}

function resetCar() {
  const n = graph.nodes[graph.nearestNode(carPos.x, carPos.z, false)];
  // face along the road toward the next node
  const e = graph.edges[n.edges[0]];
  const o = graph.nodes[graph.other(e, n.id)];
  const yaw = Math.atan2(o.x - n.x, o.z - n.z);
  const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  const p = new THREE.Vector3(n.x, 0.8, n.z).addScaledVector(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), 12).addScaledVector(right, 1.75);
  vehicle.reset(p, yaw);
}

// ------------------------------------------------------------------ main loop
const FIX = 1 / 60;
let acc = 0;
let last = performance.now();
let upsideT = 0;
let bigMap = false;
let spatialT = 0;
let fpsT = 0, fpsN = 0;
let lastDistrict: DistrictId | null = null;

const FIXED_MODE = params.has('fixed'); // deterministic sim for automated tests (1/30 s per frame)
let fpsReal = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dtReal = FIXED_MODE ? 1 / 15 : Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state === 'loading') return;
  simTime += state === 'paused' ? 0 : dtReal;
  poolUniforms.uTime.value = simTime;
  (post.lens as any).set(simTime, Q.lensFx ? 0.55 : 0, 0);

  if (state === 'playing') {
    if (input.consume('Escape') || input.consume('KeyP')) { pause(); input.endFrame(); }
    if (input.consume('KeyC')) { chase.mode = chase.mode === 'chase' ? 'far' : chase.mode === 'far' ? 'hood' : 'chase'; save.settings.cam = chase.mode; writeSave(save); }
    if (input.consume('KeyR')) resetCar();
    if (input.consume('KeyM')) { bigMap = !bigMap; show('bigmap', bigMap); }
    const inp = input.read(dtReal);
    traffic.update(dtReal, carPos, carVel, vehicle.body);
    acc += dtReal;
    let steps = 0;
    while (acc >= FIX && steps < 6) {
      vehicle.step(FIX, inp);
      phys.world.step(eventQueue);
      eventQueue.drainContactForceEvents((e) => {
        const c1 = phys.world.getCollider(e.collider1()), c2 = phys.world.getCollider(e.collider2());
        const other = c1.parent()?.handle === vehicle.body.handle ? c2 : c1;
        impact(e.totalForceMagnitude(), other);
      });
      acc -= FIX;
      steps++;
    }
    vehicle.getTransform(carPos, carQuat);
    const lv = vehicle.body.linvel();
    carVel.set(lv.x, lv.y, lv.z);
    // fell out of the world or flipped: reset
    if (carPos.y < -5) resetCar();
    if (vehicle.isUpsideDown() && vehicle.speedAbs < 2) { upsideT += dtReal; if (upsideT > 2) { resetCar(); upsideT = 0; } } else upsideT = 0;

    car.update(dtReal, vehicle, carPos, carQuat, inp.throttle);
    car.beams.visible = chase.mode !== 'hood';
    chase.update(dtReal, carPos, carQuat, carVel, vehicle.speed, vehicle.boosting, vehicle.drifting, vehicle.body);
    missions.update(dtReal, simTime, carPos, carVel, vehicle.speedAbs, vehicle.drifting, traffic.cars, () => {
      chase.impact(0.6);
      audio.play('hit_metal', { volume: 0.8 });
      vehicle.body.applyImpulse({ x: (Math.random() - 0.5) * 3000, y: 2500, z: (Math.random() - 0.5) * 3000 }, true);
    });
    emitEffects(dtReal);
    // audio
    const slip = Math.max(...vehicle.wheels.map((w) => (w.contact ? Math.abs(w.slipLat) + w.slipLong * 0.5 : 0)));
    audio.updateEngine(vehicle.rpm, inp.throttle, vehicle.speedAbs, slip, vehicle.drifting, vehicle.boosting);
    if (vehicle.boosting && !(vehicle as any)._wasBoost) audio.play('boost', { volume: 0.8 });
    (vehicle as any)._wasBoost = vehicle.boosting;
    audio.updateListener(camera);
    audio.setPos(audio.trainLoop, train.position, 1.0);
    const nearestDrone = missions.droneList[0];
    audio.setPos(audio.droneLoop, nearestDrone ? nearestDrone.mesh.position : new THREE.Vector3(0, -999, 0), nearestDrone ? 0.8 : 0);
    spatialT -= dtReal;
    if (spatialT <= 0) { spatialT = 0.5; audio.updateSpatial(city.sounds, camera.position); audio.sirens(0.12 + 0.1 * Math.sin(simTime * 0.05)); }
    // HUD
    const d = districtAt(carPos.x, carPos.z);
    if (d !== lastDistrict) { hud.setDistrict(d); if (lastDistrict && save.unlocked.includes(d)) audio.say(({ neon: 'brief_neon', backstreets: 'brief_back', downtown: 'brief_downtown', docks: 'brief_docks' } as const)[d]); lastDistrict = d; }
    hud.drawSpeedo(Math.abs(vehicle.speed) * 3.6, vehicle.rpm, vehicle.speed < -0.5 ? 0 : vehicle.gear, vehicle.boost, vehicle.boosting);
    const yaw = vehicle.yaw();
    hud.drawMinimap(carPos, yaw, missions.target, missions.route, missions.droneList.map((q) => q.mesh.position), missions.state === 'toDrop' ? 'drop' : 'pickup');
    if (bigMap) hud.drawBigMap(carPos, yaw, missions.target, missions.route);
    hud.arrow(camera, missions.target, missions.state === 'toDrop' ? '#ff2fb4' : '#21f3ff');
    hud.tick(dtReal);
    adaptiveQuality(dtReal);
    input.endFrame();
  } else if (state === 'title') {
    // slow orbit for the background (hidden behind the intro video)
    camera.position.set(SPAWN.x + Math.sin(simTime * 0.1) * 20, 6, SPAWN.z + Math.cos(simTime * 0.1) * 20);
    camera.lookAt(SPAWN);
  }
  if (state === 'title') return; // the title screen is a video; skip 3D rendering

  // world updates shared by playing/paused
  if (state === 'playing') {
    train.update(dtReal);
    skyTraffic.update(simTime, camera.position);
    sky.update(camera, simTime);
    rain.update(camera, carVel);
    splashes.update(camera);
    fogLayers.update(dtReal, camera.position, 1);
    smoke.update(dtReal);
    sparks.update(dtReal);
    city.updateVisibility(camera.position, Q.viewDistance);
    updateLightPools();
    const s = Math.min(1, vehicle.speedAbs / 60);
    (post.lens as any).set(simTime, Q.lensFx ? 0.55 * (1 - s * 0.6) : 0, (vehicle.boosting ? 0.6 : 0) * Math.min(1, vehicle.speedAbs / 30) + (s > 0.6 ? (s - 0.6) * 1.2 : 0));
    post.chroma.offset.set(0.0006 + (vehicle.boosting ? 0.0025 : 0), 0.0004 + (vehicle.boosting ? 0.0015 : 0));
  }
  renderer.info.reset();
  // car reflection probe: refresh every few frames (High: 6, Med: 15), off on Low
  if (state === 'playing' && cubeCam && cubeRT && car.paintMat && qLevel !== 'low') {
    if (cubeFrame++ % (qLevel === 'high' ? 6 : 15) === 0) {
      car.root.visible = false;
      cubeCam.position.copy(carPos).add(new THREE.Vector3(0, 1.2, 0));
      cubeCam.update(renderer, scene);
      cubeRT.texture.needsPMREMUpdate = true;
      car.root.visible = true;
      if (car.paintMat.envMap !== cubeRT.texture) { car.paintMat.envMap = cubeRT.texture; car.paintMat.envMapIntensity = 1.3; car.paintMat.needsUpdate = true; }
    }
  } else if (car && car.paintMat && cubeRT && car.paintMat.envMap === cubeRT.texture && qLevel === 'low') {
    car.paintMat.envMap = scene.environment; car.paintMat.needsUpdate = true;
  }
  reflector.update(renderer, scene, camera);
  post.render(dtReal);

  fpsN++;
  fpsT = (performance.now() - fpsReal) / 1000;
  if (fpsT > 0.5) {
    const info = renderer.info.render;
    if (params.has('debug')) hud.fps(`${Math.round(fpsN / fpsT)} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · ${qLevel}`);
    (window as any).__fps = fpsN / fpsT;
    fpsN = 0; fpsReal = performance.now();
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post?.setSize(innerWidth, innerHeight);
  reflector?.setSize(innerWidth * Q.pixelRatio, innerHeight * Q.pixelRatio);
  sparks?.setScale(innerHeight * Q.pixelRatio, camera.fov);
  smoke?.setScale(innerHeight * Q.pixelRatio, camera.fov);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// ------------------------------------------------------------------ debug / automation API (used by scripts/shots.mjs)
function debugApi() {
  return {
    start: () => startDrive(),
    simTime: () => simTime,
    setCar: (id: string) => { spawnPlayerCar(id, carPos.clone().setY(0.8), vehicle.yaw()); },
    trafficCount: () => traffic.cars.length,
    behindTraffic: (n = 0) => {
      // park the player 14 m behind the n-th nearest traffic car, facing the same way
      const list = [...traffic.cars].sort((a, b) => a.pos.distanceTo(carPos) - b.pos.distanceTo(carPos));
      const c = list[Math.min(n, list.length - 1)];
      if (!c) return null;
      const f = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
      const p = c.pos.clone().addScaledVector(f, -14);
      vehicle.reset(new THREE.Vector3(p.x, 0.8, p.z), c.yaw);
      return { model: traffic.models[c.model]?.id, pos: c.pos.toArray() };
    },
    carInfo: () => {
      const out: any = { wheelLocal: Object.fromEntries(Object.entries(car.wheelLocal).map(([k, v]) => [k, v.toArray().map((n) => +n.toFixed(2))])) };
      const b = new THREE.Box3().setFromObject(car.wheels[0]);
      out.wheel0 = [b.min.toArray().map((n) => +n.toFixed(2)), b.max.toArray().map((n) => +n.toFixed(2))];
      const bb = new THREE.Box3().setFromObject(car.body);
      out.body = [bb.min.toArray().map((n) => +n.toFixed(2)), bb.max.toArray().map((n) => +n.toFixed(2))];
      out.wheelChildren = car.wheels[0].children[0].children.length;
      out.carPos = car.root.position.toArray();
      return out;
    },
    state: () => state,
    setInput: (i: any) => { input.scripted = i; },
    teleport: (x: number, z: number, yaw: number) => { vehicle.reset(new THREE.Vector3(x, 0.8, z), yaw); },
    telemetry: () => ({ speed: vehicle.speed, kmh: vehicle.speed * 3.6, drifting: vehicle.drifting, driftAngle: vehicle.driftAngle, rpm: vehicle.rpm, gear: vehicle.gear, pos: carPos.toArray(), yaw: vehicle.yaw(), boost: vehicle.boost, airborne: vehicle.airborne, fps: (window as any).__fps, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
    camMode: (m: 'chase' | 'far' | 'hood') => { chase.mode = m; },
    quality: (l: QualityLevel) => setQuality(l),
    mission: () => ({ state: missions.state, timer: missions.timer, target: missions.target?.toArray() }),
    unlockAll: () => { for (const d of DISTRICT_ORDER) if (!save.unlocked.includes(d)) { save.unlocked.push(d); city.unlock(d); } hud.unlocked = save.unlocked; },
    hideHud: (v: boolean) => show('hud', !v),
    timeScale: 1,
    railZ: RAIL_Z, grid: GRID,
    triStats: () => {
      const m = new Map<string, number>();
      scene.traverse((o: any) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        const g = o.geometry as THREE.BufferGeometry;
        const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
        const n = o.isInstancedMesh ? o.count : 1;
        const key = (o.material?.name || o.material?.type || '?') + ':' + Math.round(tris);
        m.set(key, (m.get(key) ?? 0) + tris * n);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} -> ${(v / 1000).toFixed(0)}k`).join('\n');
    },
  };
}

// load atlas metadata then boot
Promise.all(['signs', 'ads', 'shops'].map((n) => fetch(`./assets/atlas/${n}.json`).then((r) => r.json()))).then(([signs, ads, shops]) => {
  atlasJson = { signs, ads, shops };
  boot().catch((e) => { console.error(e); $('loadlabel').textContent = `Error: ${e.message}`; });
  requestAnimationFrame(frame);
});
