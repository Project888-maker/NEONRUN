import * as THREE from 'three';
import { av } from './core/version';
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
import { Train, SkyTraffic, Drone } from './world/ambient';
import { Vehicle } from './vehicle/vehicle';
import { CarVisual, PAINTS, UNDERGLOW, liveryMaterial } from './vehicle/carVisual';
import { CAR_DEFS, carDef } from './vehicle/carModels';
import { HeroOnFoot, FootCam } from './game/onfoot';
import { Crowd, Person, PED_TYPES, type PedType, lerpAngle } from './world/people';
import { Conversation } from './npc/conversation';
import { Society } from './npc/society';
import { REGULARS, regularId } from './npc/regulars';
import { Interiors } from './world/interiors';
import { Barks } from './npc/barks';
import { voiceFor, ARCHETYPES } from './npc/persona';
import { repLabel } from './game/progress';
import { Police, carMesh } from './game/police';
import { ChaseCam } from './vehicle/chaseCam';
import { AudioSys } from './audio/audio';
import { Hud } from './game/hud';
import { Missions } from './game/missions';
import { Campaign, MISSIONS, type MissionDef } from './game/campaign';
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

// If the browser drops the WebGL context (GPU memory pressure, mostly on phones and older laptops) the canvas
// stays black for good. Step quality down one notch and reload instead of leaving a dead screen.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const order: QualityLevel[] = ['high', 'med', 'low'];
  const next = order[Math.min(2, order.indexOf(qLevel) + 1)];
  save.settings.quality = next;
  writeSave(save);
  const el = $('loadlabel');
  show('loading', true);
  el.textContent = `Graphics reset · restarting on ${next} quality…`;
  setTimeout(() => location.reload(), 1200);
}, false);

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0x0b0a18);
const fogOutdoor = new THREE.FogExp2(FOG_COLOR, 0.0062);
scene.fog = fogOutdoor;
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
let campaign: Campaign;
let eventQueue: RAPIER.EventQueue;
const graph = buildRoadGraph();
const realLights: THREE.PointLight[] = [];
const videos: Record<string, HTMLVideoElement> = {};
let lightGrid = new Map<string, LightSrc[]>();
// live reflection probe for the car paint (High/Med): renders the real neon street into a cube map
let cubeRT: THREE.WebGLCubeRenderTarget | null = null;
let cubeCam: THREE.CubeCamera | null = null;
let cubeFrame = 0;
let cubeFace = 0;
let probeHook: ((dt: number) => void) | null = null;

let state: 'loading' | 'title' | 'playing' | 'paused' = 'loading';
let simTime = 0;
let landmarkMeshes: THREE.Object3D[] = [];

const SPAWN = new THREE.Vector3(lineCoord(4) + 1.75, 0.6, -150);
const SPAWN_YAW = Math.PI;

// ------------------------------------------------------------------ boot
const loader = new Loader();
async function boot() {
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
  setP(0.85, 'Compiling shaders…');
  await new Promise((r) => setTimeout(r, 30));
  await warmUp((p) => setP(0.85 + p * 0.15, 'Compiling shaders…'));
  setP(1, 'Ready');
  hud.setCredits(save.credits);
  hud.unlocked = save.unlocked;
  showTitle();
  (window as any).__neon = debugApi();
  // stream the full-detail drivable cars in the background; swap the one being driven when it arrives
  loader.loadFullCars(A.cars, (id) => {
    if (id === carId && mode === 'drive' && state !== 'loading') spawnPlayerCar(id, carPos.clone().setY(carPos.y + 0.05), vehicle.yaw(), carVel.clone());
    void warmCompile([carMesh(A.cars[id], envTex).root]);
  }, save.car);
}

/**
 * Compile every shader the game will need before play starts (characters, all cars, police, effects)
 * and render one full frame behind the loading screen. Without this the first seconds of driving
 * stall while the GPU compiles, which can look like a frozen black screen on slower devices.
 */
async function warmUp(progress: (p: number) => void) {
  const extras: THREE.Object3D[] = [];
  for (const g of Object.values(A.people)) if (g) extras.push(new Person(g, 'warm').root);
  // meshes only: extra lights here would change the light count that every shader is compiled for
  for (const a of Object.values(A.carsLod)) extras.push(carMesh(a, envTex).root);
  const liv = Object.values(A.liveries).find(Boolean);
  if (liv) extras.push(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), liveryMaterial(liv)));
  const dr = new Drone(); dr.beam.visible = true; extras.push(dr.mesh, dr.beam);
  extras.push(...interiors.warmMeshes());
  progress(0.2);
  await warmCompile(extras);
  progress(0.7);
  // one real frame (reflection + post chain) at the spawn point
  camera.position.set(SPAWN.x, 3, SPAWN.z + 9);
  camera.lookAt(SPAWN);
  try { reflector.update(renderer, scene, camera); post.render(1 / 60); } catch (e) { console.warn('warm-up frame failed', e); }
  progress(1);
}
async function warmCompile(objs: THREE.Object3D[]) {
  const g = new THREE.Group();
  g.position.copy(SPAWN);
  objs.forEach((o, i) => { o.position.set((i % 6) * 3, 0, Math.floor(i / 6) * 3); g.add(o); });
  scene.add(g);
  // parallel (non-blocking) compile where the GPU driver supports it, plain compile otherwise
  if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera);
  else renderer.compile(scene, camera);
  scene.remove(g);
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
  const signTex = new THREE.TextureLoader().load(av('./assets/atlas/signs.webp'));
  const adTex = new THREE.TextureLoader().load(av('./assets/atlas/ads.webp'));
  const shopTex = new THREE.TextureLoader().load(av('./assets/atlas/shops.webp'));
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
  rain.setCount(Q.rainCount);
  if (params.has('raingain')) rain.uniforms.uGain.value = +params.get('raingain')!;
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
  crowd = new Crowd(Object.fromEntries(PED_TYPES.filter((t) => A.people[t]).map((t) => [t, A.people[t]])) as any, city, Q.level === 'high' ? 22 : Q.level === 'med' ? 14 : 8);
  crowd.onHit = (p, spd) => {
    audio.play('body_hit', { pos: p, volume: 1 });
    if (Math.random() < 0.6) audio.play('scream', { pos: p, volume: 0.9 });
    crowd.panic(p, 20);
    if (mode === 'drive') { noteEvent('the courier hit a pedestrian with their car', p); society.repEvent('hit', p); setTimeout(() => barks.event('hit', p, 30), 700); }
    chase.impact(Math.min(0.5, spd / 40));
    if (hitCooldown <= 0) { police.add(1, 'pedestrian'); hitCooldown = 4; }
  };
  crowd.onScream = (p) => audio.play('scream', { pos: p, volume: 0.6, rate: 0.9 + Math.random() * 0.25 });
  scene.add(crowd.group);
  crowd.onFlee = (ped, from) => { if (from.distanceTo(ped.pos) < 9 && mode === 'drive') barks?.event('near_miss', ped.pos, 1, 0.5); };
  if (A.people.hero) {
    hero = new HeroOnFoot(phys, A.people.hero);
    hero.onStep = () => audio.play('footstep_wet', { volume: 0.35, rate: 0.85 + Math.random() * 0.3 });
    hero.onLand = () => audio.play('jump_land', { volume: 0.6 });
    scene.add(hero.person.root);
  }
  footCam = new FootCam(camera, phys);
  conv = new Conversation({
    heroPerson: () => hero!.person,
    heroPos: () => hero!.pos,
    setHeroBusy: (on) => { if (hero) hero.busy = on ? 1e6 : 0; },
    persona: (t) => society.persona(t),
    recall: (p) => society.recall(p),
    remember: (p, m) => society.remember(p, m),
    job: (t, p) => society.job(t, p),
    acceptJob: (t, p) => society.acceptJob(t, p),
    facts: (p, t) => society.facts(p, t, convFacts()),
    alive: (t) => mode === 'foot' && state === 'playing' && (crowd.peds.includes(t as any) || !!interiors.active?.people.includes(t as any)) && t.state === 'talk',
    flee: (t) => crowd.flee(t as any, hero!.pos),
    callPolice: (t) => { noteEvent('a bystander called the police on the courier', t.pos); setTimeout(() => police.add(1, 'reported'), 2500); },
    voiceOn: () => (save.settings.voice ?? 'on') === 'on',
    audio,
    uncensored: () => (save.settings.language ?? 'uncensored') === 'uncensored',
    clearView: (from, to) => {
      const dir = to.clone().sub(from);
      const len = dir.length();
      const hit = phys.world.castRay(new RAPIER.Ray(from, dir.divideScalar(len)), len - 0.4, true, undefined, undefined, hero?.collider, undefined, (c) => !!c.parent()?.isFixed());
      return !hit;
    },
    onOpen: () => { document.exitPointerLock?.(); },
    onClose: () => { if (hero) footCam.yaw = hero.person.yaw; },
  }, () => A.lines);
  police = new Police(phys, graph, A.carsLod.car_police ?? A.cars.car_police, env);
  police.onHeat = (h) => renderWanted(h);
  police.onSpawn = (p) => { audio.play('radio_squelch', { volume: 0.5 }); if (Math.random() < 0.7) audio.talk(`police_${Math.floor(Math.random() * 4)}`, p); };
  police.onBusted = () => busted();
  police.onRoadblock = () => { audio.play('radio_squelch', { volume: 0.6 }); hud.toast('Roadblock ahead'); };
  scene.add(police.group);
  train = new Train(A.kit);
  scene.add(train.group);
  skyTraffic = new SkyTraffic(450);
  scene.add(skyTraffic.points);

  envTex = env;
  if (!A.carsLod[save.car] && save.car !== 'hero') save.car = 'hero';
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
  campaign = new Campaign({
    phys, city, graph, hud, audio, save, envMap: env, cars: A.carsLod, people: A.people as any,
    placePlayer: (x, z, yaw) => placePlayer(x, z, yaw),
    spawnParked: (id, x, z, yaw) => {
      const m = makeCar(id, new THREE.Vector3(x, 0.8, z), yaw);
      parkedCars.push({ ...m, id, keep: true });
      return m.vehicle;
    },
    removeParked: (h) => {
      const i = parkedCars.findIndex((p) => p.vehicle === h);
      if (i >= 0) { const p = parkedCars.splice(i, 1)[0]; p.car.root.removeFromParent(); p.vehicle.dispose(); }
    },
    inCar: (h) => mode === 'drive' && vehicle === h,
    addHeat: (n) => police.add(n, 'story'),
    clearHeat: () => police.clear(),
    unlock: (d) => {
      if (save.unlocked.includes(d)) return;
      save.unlocked.push(d); writeSave(save);
      city.unlock(d); hud.unlocked = save.unlocked;
    },
    subtitle: (who, text, dur) => subtitle(who, text, dur),
    droneHit: () => {
      chase.impact(0.6);
      audio.play('hit_metal', { volume: 0.8 });
      if (mode === 'drive') vehicle.body.applyImpulse({ x: (Math.random() - 0.5) * 3000, y: 2500, z: (Math.random() - 0.5) * 3000 }, true);
    },
    choose: (c) => {
      $('r-actions').innerHTML = '';
      const def = campaign.active;
      if (c === 'free' || !def) { campaign.stop(); missions.suspend(false, playerPos); return; }
      startStory(c === 'next' ? MISSIONS[def.n] ?? def : def);
    },
  });
  scene.add(campaign.group);
  society = new Society({
    crowd, campaign, save, hud, audio, spots: city.spots,
    playerPos: () => streetPos(),
    busy: () => missions.state === 'toDrop',
    counter: (id) => interiors.room(id).counter,
    inside: () => interiors.active?.placeId ?? null,
    suspendDeliveries: (on) => missions.suspend(on, playerPos),
  });
  interiors = new Interiors({
    phys, scene, people: A.people as any, places: society.places,
    regularAt: (id) => { const r = REGULARS.find((q) => q.home === id); return r ? { type: r.type, key: regularId(r) } : null; },
  });
  scene.add(interiors.doors);
  barks = new Barks({
    crowdPeds: () => crowd.peds,
    speaker: (ped) => {
      const p = society.persona(ped as any);
      const known = !ped.key || (save.npc[p.id]?.met ?? 0) > 0;
      const v = voiceFor(p, ped.type);
      return { name: known && ped.key ? p.name : ARCHETYPES[ped.type]?.title ?? 'Stranger', voice: v.name, speed: v.speed, key: p.id };
    },
    voice: (v, text, speed) => conv.voices.get(v, text, speed),
    play: (buf, pos) => audio.playRemark(buf, pos),
    subtitle: (who, text, dur) => { if (!conv.active) subtitle(who, text, dur); },
    voiceOn: () => (save.settings.voice ?? 'on') === 'on',
    quiet: () => !!conv.active || state !== 'playing' || !!interiors.active,
  });

  // video billboards
  for (const clip of new Set(city.videoScreens.map((s) => s.clip))) {
    const v = document.createElement('video');
    v.src = av(`./assets/video/${clip}.mp4`);
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
function spawnPlayerCar(id: string, pos: THREE.Vector3, yaw: number, vel?: THREE.Vector3, keepOld = false) {
  if (keepOld && car && vehicle) {
    // leave the previous car parked where it is
    parkedCars.push({ vehicle, car, id: carId });
    evictParked();
  } else {
    if (car) { car.root.removeFromParent(); }
    if (vehicle) vehicle.dispose();
  }
  ({ car, vehicle } = makeCar(id, pos, yaw));
  vehicle.onShift = (g) => { if (state === 'playing' && g > 1) audio.play('gear_shift', { volume: 0.45 }); };
  if (vel) vehicle.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
  carId = id;
  if (cubeRT && car.paintMat) { car.paintMat.envMap = cubeRT.texture; car.paintMat.needsUpdate = true; }
}
let carId = 'hero';

/** Build a car (visual + physics) without making it the player's. */
function makeCar(id: string, pos: THREE.Vector3, yaw: number) {
  // full-detail model once it has streamed in, the traffic version until then
  const asset = id === 'hero' ? undefined : A.cars[id] ?? A.carsLod[id];
  const def = id === 'hero' ? HERO_DEF : carDef(id)!;
  const c = new CarVisual(asset ? null : A.car, A.kit, envTex, asset);
  const wp = Object.fromEntries(Object.entries(c.wheelLocal).map(([k, v]) => [k, v.clone()]));
  const v = new Vehicle(phys, pos, yaw, Object.keys(wp).length === 4 ? wp : undefined, {
    mass: def.mass, power: def.power, topSpeed: def.topSpeed, grip: def.grip,
    wheelRadius: asset ? asset.spec.wheelRadius : undefined, dims: c.dims,
  });
  v.upgrades = id === 'hero' ? { ...save.upgrades } : { speed: 0, grip: 0, boost: 0 };
  scene.add(c.root);
  // park it visually right away (its update runs in the frame loop)
  const pp = new THREE.Vector3(), pq = new THREE.Quaternion();
  v.getTransform(pp, pq);
  c.update(0, v, pp, pq, 0);
  return { car: c, vehicle: v };
}

/** At most two cars stay parked around the city (story cars marked keep are never evicted). */
function evictParked() {
  while (parkedCars.filter((p) => !p.keep).length > 2) {
    const i = parkedCars.findIndex((p) => !p.keep);
    const old = parkedCars.splice(i, 1)[0];
    old.car.root.removeFromParent(); old.vehicle.dispose();
  }
}

/** Put the player back in their own car on a road (story mission start). */
function placePlayer(x: number, z: number, yaw: number) {
  if (hero && mode !== 'drive') { hero.hide(); hero.busy = 0; hero.frozen = false; }
  carSeq = null;
  mode = 'drive';
  seqDone = null;
  talking = 0;
  conv?.leave();
  setContext(null);
  document.exitPointerLock?.();
  // clear the player's leftover cars, but keep cars the current mission just parked
  for (let i = parkedCars.length - 1; i >= 0; i--) {
    if (parkedCars[i].keep) continue;
    const p = parkedCars.splice(i, 1)[0];
    p.car.root.removeFromParent(); p.vehicle.dispose();
  }
  const pos = new THREE.Vector3(x, 0.8, z);
  if (carId !== save.car) spawnPlayerCar(save.car, pos, yaw);
  else vehicle.reset(pos, yaw);
  applyCustomization();
  vehicle.getTransform(carPos, carQuat);
  playerPos.copy(carPos);
  chase.snap();
}

// ---- on foot / car switching state
type Mode = 'drive' | 'foot' | 'enter' | 'exit';
let mode: Mode = 'drive';
let hero: HeroOnFoot | null = null;
let footCam: FootCam;
let crowd: Crowd;
let police: Police;
let conv: Conversation;
let society: Society;
let barks: Barks;
let interiors: Interiors;
/** outside things hidden while the courier is indoors (restored on leaving) */
let hiddenOutside: THREE.Object3D[] = [];
/** where the courier is on the street (the door of the place while indoors) */
function streetPos() { return interiors?.active ? interiors.entrance(interiors.active.placeId) : playerPos; }
/** things the courier did that bystanders may have seen (fed to the NPC brain) */
const recentEvents: { t: number; pos: THREE.Vector3; text: string }[] = [];
function noteEvent(text: string, pos: THREE.Vector3) { recentEvents.push({ t: simTime, pos: pos.clone(), text }); if (recentEvents.length > 12) recentEvents.shift(); }
const parkedCars: { vehicle: Vehicle; car: CarVisual; id: string; keep?: boolean }[] = [];
const PARK = { throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false };
let seqT = 0;
let seqDone: (() => void) | null = null;
let talking = 0;
let hitCooldown = 0;
const playerPos = new THREE.Vector3();
const playerVel = new THREE.Vector3();

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
canvas.addEventListener('click', () => { if (state === 'playing' && mode === 'foot' && !matchMedia('(pointer: coarse)').matches) canvas.requestPointerLock?.(); });
addEventListener('keydown', unlockAudio);

document.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
  b.addEventListener('mouseenter', () => audio.play('ui_hover', { volume: 0.25 }));
  b.addEventListener('click', () => {
    audio.play('ui_click', { volume: 0.6 });
    const act = b.dataset.act!;
    if (act === 'play') startDrive();
    if (act === 'story') openStory();
    if (act === 'm-restart' && campaign.active) { const d = campaign.active; resume(); startStory(d); }
    if (act === 'm-abandon' && campaign.active) { resume(); campaign.stop(); missions.suspend(false, playerPos); }
    if (act === 'garage') openGarage();
    if (act === 'settings') openSettings();
    if (act === 'controls') { show('title', false); show('controls', true); }
    if (act === 'back') { ['garage', 'settings', 'controls', 'story'].forEach((s) => show(s, false)); show(menuReturn === 'pause' ? 'pause' : 'title', true); }
    if (act === 'resume') resume();
    if (act === 'quit') quitToTitle();
  });
});

function openStory() {
  show('title', false); show('story', true);
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  $('story-list').innerHTML = MISSIONS.map((m, i) => {
    const done = save.story.done.includes(m.id);
    const open = i === 0 || save.story.done.includes(MISSIONS[i - 1].id) || params.has('allmissions');
    const best = save.story.best[m.id];
    return `<div class="card ${done ? 'done' : ''} ${open ? '' : 'locked'}"><img src="${av(`./assets/ui/missions/${m.id}.webp`)}" alt="" loading="lazy">
      <div class="m-n">${String(m.n).padStart(2, '0')} · ${DISTRICTS[m.district].name} · ${m.type}</div>
      <div class="c-head">${m.title}</div><div class="desc">${m.desc}</div>
      <div class="m-foot">${m.reward.toLocaleString()} CR${best !== undefined ? ` · best ${fmt(best)}` : ''}</div>
      <button data-m="${m.id}" ${open ? '' : 'disabled'}${!done && open ? ' class="primary"' : ''}>${open ? (done ? 'Replay' : 'Play') : 'Locked'}</button></div>`;
  }).join('');
  $('story-list').querySelectorAll<HTMLButtonElement>('button[data-m]').forEach((b) => b.addEventListener('click', () => {
    audio.play('ui_confirm', { volume: 0.6 });
    show('story', false);
    startDrive(MISSIONS.find((m) => m.id === b.dataset.m));
  }));
}

/** Start a story mission behind a short fade: the click returns at once (no frozen button), the heavy
 * work (placing the car, building the mission) runs while the screen is black. */
function startStory(def: MissionDef) { fade(() => startStoryNow(def)); }
function startStoryNow(def: MissionDef) {
  missions.suspend(true, playerPos);
  campaign.start(def);
  $('pause').classList.add('in-story');
}

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
    return `<div class="card"><div class="c-head"><img src="${av(`./assets/icon/${u.icon}.png`)}" alt="">${u.name}</div>
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
    Object.keys(A.liveries).map((l) => `<div class="swatch ${save.livery === l ? 'on' : ''}" data-liv="${l}" style="background-image:url(${av(`./assets/livery/${l}.png`)})"></div>`).join('');
  const bar = (v: number, max: number) => `<div class="pips">${[0, 1, 2, 3, 4].map((i) => `<i class="${i < Math.round((v / max) * 5) ? 'on' : ''}"></i>`).join('')}</div>`;
  $('cars').innerHTML = [HERO_DEF, ...CAR_DEFS.filter((d) => A.carsLod[d.id])].map((d) => {
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
    return `<div class="card ${un ? '' : 'locked'}"><img src="${av(`./assets/ui/${img}.webp`)}" alt=""><div class="d-name">${DISTRICTS[d].name}${un ? '' : ` · ${UNLOCK_AT[d]} deliveries`}</div></div>`;
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
  car.setLivery(save.livery ? A.liveries[save.livery] : null);
}

function openSettings() {
  show('title', false); show('pause', false); show('settings', true);
  const segQ = $('q-seg'), segC = $('cam-seg');
  const refresh = () => {
    segQ.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.q === save.settings.quality));
    segC.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.cam === save.settings.cam));
    $('voice-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.voice === (save.settings.voice ?? 'on')));
    $('lang-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.lang === (save.settings.language ?? 'uncensored')));
  };
  segQ.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
    save.settings.quality = b.dataset.q as any;
    writeSave(save);
    setQuality(save.settings.quality === 'auto' ? autoLevel : (save.settings.quality as QualityLevel));
    refresh();
  }));
  segC.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { save.settings.cam = b.dataset.cam as any; chase.mode = save.settings.cam; writeSave(save); refresh(); }));
  $('voice-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { save.settings.voice = b.dataset.voice as 'on' | 'off'; writeSave(save); refresh(); }));
  $('lang-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { save.settings.language = b.dataset.lang as 'uncensored' | 'mild'; writeSave(save); refresh(); }));
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
  rain.setCount(Q.rainCount);
  splashes.mesh.count = Q.splashCount;
  (traffic as any).count = Q.traffic;
  if (crowd) crowd.target = l === 'high' ? 22 : l === 'med' ? 14 : 8;
  sparks.setScale(innerHeight * Q.pixelRatio, camera.fov);
  smoke.setScale(innerHeight * Q.pixelRatio, camera.fov);
}

if (isMobile() || params.has('touch')) document.body.classList.add('touch');

function startDrive(story?: MissionDef) {
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
  if (story) startStory(story);
  else {
    if (campaign.active) campaign.stop();
    $('pause').classList.remove('in-story');
    if (missions.suspended) missions.suspend(false, carPos); else missions.newJob(carPos);
    hud.banner(DISTRICTS[districtAt(carPos.x, carPos.z)].name, 'Night shift');
  }
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
  conv?.leave();
  show('pause', false);
  if (campaign.active) campaign.stop();
  $('results').classList.add('hidden'); $('results').classList.remove('story'); $('r-actions').innerHTML = '';
  $('pause').classList.remove('in-story');
  audio.ctx.resume();
  showTitle();
}

// ------------------------------------------------------------------ touch controls
function setupTouch() {
  // virtual stick: appears under the thumb, knob follows the finger, clamped to the ring
  const zone = $('t-steer'), base = $('t-base'), knob = $('t-knob');
  let id: number | null = null, ox = 0, oy = 0;
  const radius = () => base.offsetWidth * 0.42;
  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    id = e.pointerId; ox = e.clientX; oy = e.clientY;
    base.classList.add('free');
    base.style.left = `${ox}px`; base.style.bottom = `${innerHeight - oy}px`;
    zone.setPointerCapture(e.pointerId);
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const R = radius();
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const l = Math.hypot(dx, dy);
    if (l > R) { dx *= R / l; dy *= R / l; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.touch.steer = dx / R;
    input.touch.moveY = -dy / R;
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null; input.touch.steer = 0; input.touch.moveY = 0;
    knob.style.transform = '';
    base.classList.remove('free'); base.style.left = ''; base.style.bottom = '';
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);

  // on foot: drag the right side of the screen to look around
  const look = $('t-look');
  let lid: number | null = null, lx = 0, ly = 0;
  look.addEventListener('pointerdown', (e) => { lid = e.pointerId; lx = e.clientX; ly = e.clientY; look.setPointerCapture(e.pointerId); });
  look.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lid) return;
    footCam.yaw -= (e.clientX - lx) * 0.006;
    footCam.pitch = THREE.MathUtils.clamp(footCam.pitch + (e.clientY - ly) * 0.004, -0.35, 0.9);
    lx = e.clientX; ly = e.clientY;
  });
  const lend = (e: PointerEvent) => { if (e.pointerId === lid) lid = null; };
  look.addEventListener('pointerup', lend);
  look.addEventListener('pointercancel', lend);

  const hold = (el: string, on: () => void, off: () => void) => {
    const b = $(el);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('held'); b.setPointerCapture(e.pointerId); on(); });
    const up = () => { b.classList.remove('held'); off(); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  };
  hold('t-gas', () => (input.touch.throttle = 1), () => (input.touch.throttle = 0));
  hold('t-brake', () => (input.touch.brake = 1), () => (input.touch.brake = 0));
  hold('t-drift', () => (input.touch.handbrake = true), () => (input.touch.handbrake = false));
  hold('t-boost', () => (input.touch.boost = true), () => (input.touch.boost = false));
  hold('t-run', () => (input.touch.run = true), () => (input.touch.run = false));
  const tap = (el: string, code: string) => $(el).addEventListener('pointerdown', (e) => { e.preventDefault(); input.pressed.add(code); });
  tap('t-jump', 'Space');
  tap('t-action', 'KeyE');
  tap('t-talk', 'KeyT');
  $('t-pause').addEventListener('click', pause);
}

/** Context buttons on touch screens: shown only when the action is possible right now. */
function setTouchCtx(action: string | null, talk: string | null) {
  const a = $('t-action'), t = $('t-talk');
  a.classList.toggle('hidden', !action);
  t.classList.toggle('hidden', !talk);
  if (action && a.textContent !== action) a.textContent = action;
  if (talk && t.textContent !== talk) t.textContent = talk;
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
  if (interiors?.active) { roomLights(interiors.active.lights); return; }
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
  const ob = objective();
  if (ob.target) dynLights.push({ pos: ob.target.clone().setY(2), color: ob.kind === 'drop' ? new THREE.Color(1, 0.2, 0.7) : new THREE.Color(0.2, 0.9, 1), radius: 16 });
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
  // on foot the real lights gather around the hero (they light skin and clothes), in the car around the car paint
  const lightFocus = mode === 'drive' ? carPos : playerPos;
  const near = cand.filter((c) => c.l.pos.distanceTo(lightFocus) < 28 && !dynLights.includes(c.l as any)).slice(0, Q.realLights);
  realLights.forEach((rl, i) => {
    const c = near[i];
    if (!c) { rl.intensity = 0; return; }
    rl.position.copy(c.l.pos);
    rl.color.copy(c.l.color);
    rl.distance = c.l.radius * 2.2;
    rl.intensity = 60;
  });
}

/** Indoors the room's own lamps light people (pools) and the hero (real point lights). */
function roomLights(L: { pos: THREE.Vector3; color: THREE.Color; radius: number }[]) {
  const P = poolUniforms.uPoolPos.value, C = poolUniforms.uPoolCol.value;
  for (let i = 0; i < MAX_POOLS; i++) {
    const l = L[i];
    if (!l) { P[i].set(0, -999, 0, 1); C[i].set(0, 0, 0); continue; }
    P[i].set(l.pos.x, l.pos.y, l.pos.z, l.radius);
    C[i].set(l.color.r, l.color.g, l.color.b).multiplyScalar(1.1);
  }
  const near = L.slice().sort((a, b) => a.pos.distanceTo(playerPos) - b.pos.distanceTo(playerPos));
  realLights.forEach((rl, i) => {
    const l = near[i];
    if (!l || i >= Q.realLights) { rl.intensity = 0; return; }
    rl.position.copy(l.pos); rl.color.copy(l.color); rl.distance = l.radius * 2; rl.intensity = 28;
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
  if (mode === 'drive') campaign?.onImpact(strength);
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

// ------------------------------------------------------------------ on foot: get in / out, steal, talk
function carDoor(pos: THREE.Vector3, yaw: number, halfWidth: number) {
  return new THREE.Vector3(halfWidth + 0.55, 0, 0.35).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(pos).setY(0.05);
}

function renderWanted(h: number) {
  const el = $('h-wanted');
  el.innerHTML = h > 0 ? [0, 1, 2, 3, 4].map((i) => `<span class="${i < h ? '' : 'off'}">★</span>`).join('') : '';
  el.classList.toggle('flash', h > 0);
  const story = campaign?.state === 'run' ? campaign.active : null;
  if (h > 0) audio.music_(story?.music === 'finale' ? 'finale' : 'chase');
  else if (story) audio.music_(story.music ?? 'drive');
  else if (missions?.state !== 'toDrop') audio.music_('chill');
}

function setContext(text: string | null) {
  const el = $('context');
  if (!text) { el.classList.add('hidden'); return; }
  el.innerHTML = text;
  el.classList.remove('hidden');
}

let subT = 0;
function subtitle(who: string, text: string, dur: number) {
  const el = $('subtitle');
  el.innerHTML = `<span class="who">${who}</span>${text}`;
  el.classList.remove('hidden');
  subT = dur;
}

function busted() {
  society.repEvent('busted', playerPos);
  campaign.onBusted();
  show('busted', true);
  audio.play('radio_squelch');
  audio.talk('police_3');
  const fine = Math.round(save.credits * 0.15);
  save.credits -= fine;
  writeSave(save);
  hud.setCredits(save.credits);
  setTimeout(() => {
    show('busted', false);
    police.clear();
    hud.toast(`Busted · fine ${fine.toLocaleString()} CR`);
    if (mode !== 'drive' && hero) { hero.hide(); hero.frozen = false; carSeq = null; seqDone = null; mode = 'drive'; }
    resetCar();
  }, 2600);
}

/**
 * Scripted get-in / get-out. The visible hero moves between the driver door and the seat while the
 * body turns from facing the door to facing along the car. The generated clips turn the body by
 * themselves (to sit down / stand up); that turn is measured per clip and compensated, so the body
 * always faces the right way and he never ends up spinning around outside the car.
 */
interface CarSeq {
  t: number; clip: 'enter_car' | 'exit_car'; clipT0: number; rate: number;
  from: THREE.Vector3; to: THREE.Vector3; moveA: number; moveB: number;
  bodyFrom: number; bodyTo: number; turnA: number; turnB: number;
}
let carSeq: CarSeq | null = null;
const smooth01 = (x: number) => { const k = THREE.MathUtils.clamp(x, 0, 1); return k * k * (3 - 2 * k); };

function updateCarSeq(dt: number) {
  if (!carSeq || !hero) return;
  const q = carSeq;
  q.t += dt;
  const k = smooth01((q.t - q.moveA) / Math.max(1e-3, q.moveB - q.moveA));
  const p = q.from.clone().lerp(q.to, k);
  const body = lerpAngle(q.bodyFrom, q.bodyTo, smooth01((q.t - q.turnA) / Math.max(1e-3, q.turnB - q.turnA)));
  const clipT = Math.min(hero.person.clipDuration(q.clip), q.clipT0 + q.t * q.rate);
  hero.person.place(p.x, p.y, p.z, body - hero.person.heading(q.clip, clipT));
}

/** seat position (driver side, slightly forward of centre) and door for a car */
function seatOf(pos: THREE.Vector3, yaw: number, halfWidth: number) {
  return new THREE.Vector3(halfWidth * 0.32, 0, 0.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(pos).setY(0.12);
}

/** Leave the current car: it stays parked, the hero swings out of the driver seat and stands up at the door. */
function startExit() {
  if (!hero || vehicle.speedAbs > 7) return;
  mode = 'exit';
  const yaw = vehicle.yaw();
  const door = carDoor(carPos, yaw, car.dims.width / 2);
  const seat = seatOf(carPos, yaw, car.dims.width / 2);
  hero.spawn(door, yaw + Math.PI / 2);
  hero.frozen = true;
  const D = hero.person.clipDuration('exit_car');
  const rate = 1.6, clipT0 = D * 0.35; // start once the legs are swinging out; the car hides the seated part
  hero.person.play('exit_car', { loop: false, fade: 0.05, speed: rate, restart: true, from: clipT0 });
  const dur = (D - clipT0) / rate;
  carSeq = { t: 0, clip: 'exit_car', clipT0, rate, from: seat, to: door, moveA: 0, moveB: dur * 0.5, bodyFrom: yaw, bodyTo: yaw + Math.PI / 2, turnA: 0, turnB: dur * 0.55 };
  updateCarSeq(0);
  hero.busy = dur;
  audio.play('door_open', { pos: door, volume: 0.8 });
  setTimeout(() => audio.play('door_close', { pos: door, volume: 0.9 }), dur * 750);
  footCam.reset(yaw);
  seqT = dur;
  seqDone = () => {
    carSeq = null;
    if (!hero) return;
    hero.frozen = false;
    hero.place(door);
    hero.person.yaw = yaw + Math.PI / 2;
    hero.person.play('idle', { fade: 0.35 });
    mode = 'foot';
  };
  if (!matchMedia('(pointer: coarse)').matches) canvas.requestPointerLock?.();
}

/** Find the car the hero can get into: own/parked cars first, then traffic (stealing). */
function enterTarget() {
  if (!hero) return null;
  const hp = hero.pos;
  const own = [{ vehicle, car, id: carId, parkedIndex: -1 }, ...parkedCars.map((p, i) => ({ ...p, parkedIndex: i }))];
  for (const o of own) {
    const t = o.vehicle.body.translation();
    const door = carDoor(new THREE.Vector3(t.x, 0, t.z), o.vehicle.yaw(), o.car.dims.width / 2);
    if (door.distanceTo(hp.clone().setY(0.05)) < 2.6) return { kind: 'own' as const, o, door };
  }
  const tc = traffic.nearestCar(hp, 3.2);
  if (tc) return { kind: 'traffic' as const, tc, door: carDoor(tc.pos, tc.yaw, (traffic.models[tc.model]?.width ?? 1.9) / 2) };
  return null;
}

function startEnter() {
  const tgt = enterTarget();
  if (!tgt || !hero) return;
  mode = 'enter';
  document.exitPointerLock?.();
  hero.place(tgt.door);
  let delay = 0;
  if (tgt.kind === 'traffic') {
    // carjack: shove the driver out, take the car
    tgt.tc.stunned = 99;
    const yawTo = Math.atan2(tgt.tc.pos.x - tgt.door.x, tgt.tc.pos.z - tgt.door.z);
    hero.person.yaw = yawTo;
    const pd = hero.person.play('push', { loop: false, fade: 0.08, speed: 1.6, restart: true });
    delay = pd / 1.6;
    audio.play('door_open', { pos: tgt.door });
    setTimeout(() => {
      audio.play('carjack', { pos: tgt.door, volume: 1 });
      const type = PED_TYPES[Math.floor(Math.random() * PED_TYPES.length)] as PedType;
      const out = tgt.door.clone().add(new THREE.Vector3(Math.sin(yawTo + Math.PI), 0, Math.cos(yawTo + Math.PI)).multiplyScalar(0.9));
      crowd.ejectDriver(type, out, tgt.tc.pos);
      const vi = Math.floor(Math.random() * 4);
      audio.talk(`victim_${vi}`, out).then((dur) => subtitle('Driver', A.lines.victim?.[vi] ?? '', dur + 0.5));
      crowd.panic(tgt.door, 25);
      noteEvent('the courier dragged a driver out of their car and stole it', tgt.door);
      society.repEvent('carjack', tgt.door);
      setTimeout(() => barks.event('carjack', tgt.door, 30), 900);
      const near = police.units.some((u) => u.pos.distanceTo(tgt.door) < 80);
      police.add(near ? 2 : 1, 'carjack');
    }, delay * 400);
  } else {
    hero.person.yaw = tgt.o.vehicle.yaw() - Math.PI / 2;
  }
  setTimeout(() => {
    if (!hero) return;
    // reach for the handle at the door, then slide into the seat while turning to face forward
    const cPos = tgt.kind === 'traffic' ? tgt.tc.pos.clone() : (() => { const t = tgt.o.vehicle.body.translation(); return new THREE.Vector3(t.x, 0, t.z); })();
    const cYaw = tgt.kind === 'traffic' ? tgt.tc.yaw : tgt.o.vehicle.yaw();
    const halfW = tgt.kind === 'traffic' ? (traffic.models[tgt.tc.model]?.width ?? 1.9) / 2 : tgt.o.car.dims.width / 2;
    const seat = seatOf(cPos, cYaw, halfW);
    const D = hero.person.clipDuration('enter_car');
    const rate = 1.6, clipEnd = D * 0.72; // stop once seated; the rest of the clip is settling in
    hero.frozen = true;
    hero.person.play('enter_car', { loop: false, fade: 0.12, speed: rate, restart: true });
    const dur = clipEnd / rate, reach = (D * 0.25) / rate;
    carSeq = { t: 0, clip: 'enter_car', clipT0: 0, rate, from: tgt.door.clone().setY(0.05), to: seat, moveA: reach, moveB: dur, bodyFrom: cYaw - Math.PI / 2, bodyTo: cYaw, turnA: reach * 0.8, turnB: dur * 0.95 };
    updateCarSeq(0);
    hero.busy = dur;
    if (tgt.kind === 'own') audio.play('door_open', { pos: tgt.door });
    seqT = dur;
    seqDone = () => {
      carSeq = null;
      hero!.frozen = false;
      audio.play('door_close', { pos: tgt.door, volume: 0.9 });
      hero!.hide();
      if (tgt.kind === 'traffic') {
        const taken = traffic.takeCar(tgt.tc);
        if (taken) spawnPlayerCar(taken.id, taken.pos.clone().setY(0.6), taken.yaw, undefined, true);
      } else if (tgt.o.parkedIndex >= 0) {
        // swap: the car we leave becomes parked, the parked one becomes ours
        const p = parkedCars.splice(tgt.o.parkedIndex, 1)[0];
        parkedCars.push({ vehicle, car, id: carId });
        vehicle = p.vehicle; car = p.car; carId = p.id;
        if (cubeRT && car.paintMat) { car.paintMat.envMap = cubeRT.texture; car.paintMat.needsUpdate = true; }
      }
      mode = 'drive';
    };
  }, delay * 1000);
  hero.busy = 9;
}

function talkTo() {
  if (!hero || conv.active) return;
  if (interiors.active) {
    const q = interiors.nearest(hero.pos, 3.2);
    if (!q) return;
    if (q.state !== 'talk') q.prevState = q.state;
    q.state = 'talk'; q.t = 999;
    conv.start(q);
    return;
  }
  const ped = crowd.nearest(hero.pos, 2.8);
  if (!ped) return;
  crowd.talk(ped, hero.pos, 999);
  conv.start(ped);
}

/** Black flash between the street and a room. */
function fade(mid: () => void) {
  const el = $('fade');
  el.classList.add('on');
  setTimeout(() => { try { mid(); } catch (e) { doorBusy = false; reportFrameError(e); } finally { setTimeout(() => el.classList.remove('on'), 60); } }, 260);
}

let doorBusy = false;
function enterPlace(id: string) {
  if (!hero || interiors.active || doorBusy) return;
  doorBusy = true;
  const room = interiors.room(id);
  hero.busy = 0.6;
  audio.play('door_open', { volume: 0.7 });
  fade(() => {
    interiors.active = room;
    const keep = new Set<THREE.Object3D>([room.group, hero!.person.root, campaign.group, ...room.people.map((q) => q.p.root)]);
    hiddenOutside = scene.children.filter((o) => o.visible && !keep.has(o) && !(o as THREE.Light).isLight && o !== camera);
    for (const o of hiddenOutside) o.visible = false;
    scene.fog = null;
    reflector.enabled = false;
    hero!.place(room.spawn);
    hero!.person.yaw = room.spawnYaw;
    footCam.reset(room.spawnYaw);
    audio.indoors(true);
    document.body.classList.add('indoors');
    poolFrame = 0;
    doorBusy = false;
  });
}

function exitPlace() {
  const room = interiors.active;
  if (!room || !hero || doorBusy) return;
  doorBusy = true;
  if (conv.active) conv.leave();
  audio.play('door_close', { volume: 0.7 });
  fade(() => {
    interiors.active = null;
    for (const o of hiddenOutside) o.visible = true;
    hiddenOutside = [];
    scene.fog = fogOutdoor;
    reflector.enabled = Q.reflection;
    const ps = society.places.get(room.placeId)!;
    const out = ps.stand.clone().add(new THREE.Vector3(ps.spot.nx, 0, ps.spot.nz).multiplyScalar(0.6)).setY(0.2);
    hero!.place(out);
    const yaw = Math.atan2(ps.spot.nx, ps.spot.nz);
    hero!.person.yaw = yaw;
    footCam.reset(yaw);
    audio.indoors(false);
    document.body.classList.remove('indoors');
    poolFrame = 0;
    doorBusy = false;
  });
}

/** What a bystander knows about this moment (fed to the NPC brain with every line). */
function convFacts(): string[] {
  const sp = streetPos();
  const d = districtAt(sp.x, sp.z);
  const room = interiors.active ? society.places.get(interiors.active.placeId)?.place.name : null;
  const f = [room ? `Place: inside ${room}, ${DISTRICTS[d].name}` : `Place: ${DISTRICTS[d].name}, on a wet sidewalk`, `Time: the middle of the night, steady rain${room ? ' outside' : ', neon reflecting in puddles'}`];
  if (police.heat > 0) f.push(`The courier is wanted by the police right now (${police.heat} of 5 stars); sirens in the area`);
  for (const e of recentEvents) {
    const ago = simTime - e.t;
    if (ago < 120 && e.pos.distanceTo(sp) < 70) f.push(`About ${Math.max(5, Math.round(ago / 5) * 5)} seconds ago, close by: ${e.text}`);
  }
  if (carPos.distanceTo(sp) < 14) f.push(`The courier's car (${carDef(carId)?.name ?? 'a car'}) is parked a few metres away`);
  if (campaign.active) f.push('The courier seems to be in the middle of a job, checking their phone for directions');
  else if (missions?.state === 'toDrop') f.push('The courier is carrying a parcel for a delivery');
  return f;
}

function handleInteractions() {
  const e = input.consume('KeyE') || input.consume('KeyF');
  const t = input.consume('KeyT');
  if (mode === 'drive') {
    if (e && hero) startExit();
    setContext(null);
    setTouchCtx(hero && vehicle.speedAbs < 7 ? 'EXIT' : null, null);
  } else if (conv.active) {
    setContext(null); setTouchCtx(null, null);
  } else if (mode === 'foot' && hero) {
    const story = campaign.interaction && campaign.interaction.at.distanceTo(hero.pos.setY(campaign.interaction.at.y)) < 2.8 ? campaign.interaction : null;
    const inside = interiors.active;
    const tgt = inside ? null : enterTarget();
    const door = !inside && !tgt ? interiors.nearestDoor(hero.pos) : null;
    // build the room behind a door you are walking towards, so it's ready (walls loaded) when you step in
    if (!inside) { const soon = interiors.nearestDoor(hero.pos, 30); if (soon) interiors.room(soon); }
    const leave = inside && hero.pos.distanceTo(inside.exit) < 1.8;
    if (e) { if (leave) exitPlace(); else if (door) enterPlace(door); else if (!inside) startEnter(); }
    if (t) { if (story) story.run(); else talkTo(); }
    if (inside || door) {
      const q = story ? null : inside ? interiors.nearest(hero.pos, 3.2) : null;
      const who = q ? society.persona(q) : null;
      const label = who && (q!.key ? (save.npc[who.id]?.met ?? 0) > 0 : true) ? `Talk to ${q!.key ? who.name : who.name.split(' ')[0]}` : 'Talk';
      const doorName = door ? society.places.get(door)!.place.name.replace(/^the /, '') : '';
      setContext(story ? `<b>T</b> · ${story.label}` : leave ? '<b>E</b> · Leave' : door ? `<b>E</b> · Enter ${doorName}` : q ? `<b>T</b> · ${label}` : null);
      setTouchCtx(leave ? 'LEAVE' : door ? 'ENTER' : null, story ? 'GIVE' : q ? 'TALK' : null);
      document.body.classList.toggle('on-foot', true);
      return;
    }
    const ped = story ? null : crowd.nearest(hero.pos, 2.8);
    const known = ped?.key ? society.persona(ped) : null;
    const talkLabel = known && (save.npc[known.id]?.met ?? 0) > 0 ? `Talk to ${known.name}` : 'Talk';
    setContext(story ? `<b>T</b> · ${story.label}` : tgt ? `<b>E</b> · ${tgt.kind === 'traffic' ? 'Steal car' : 'Get in'}` : ped ? `<b>T</b> · ${talkLabel}` : null);
    setTouchCtx(tgt ? (tgt.kind === 'traffic' ? 'STEAL' : 'GET IN') : null, story ? 'GIVE' : ped ? 'TALK' : null);
  } else { setContext(null); setTouchCtx(null, null); }
  document.body.classList.toggle('on-foot', mode !== 'drive');
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

/** The current objective: the story mission when one runs, otherwise the free-ride job. */
function objective() {
  if (campaign?.active) return { target: campaign.target, route: campaign.route, kind: campaign.markerKind, drones: campaign.drones };
  return { target: missions?.target ?? null, route: missions?.route ?? [], kind: (missions?.state === 'toDrop' ? 'drop' : 'pickup') as 'drop' | 'pickup', drones: missions?.droneList ?? [] };
}

// ------------------------------------------------------------------ main loop
/**
 * Safety net: an unexpected error in one frame's update must never freeze the game (it used to leave the
 * last picture on screen with only the music playing). The frame still renders, the error goes to the
 * console, and a small note appears once so a player can screenshot it for us.
 */
const seenErrors = new Set<string>();
function reportFrameError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('frame error', e);
  if (seenErrors.has(msg)) return;
  seenErrors.add(msg);
  let el = document.getElementById('err-note');
  if (!el) {
    el = document.createElement('div');
    el.id = 'err-note';
    document.body.appendChild(el);
  }
  const where = e instanceof Error && e.stack ? e.stack.split('\n')[1]?.trim().replace(/\(?https?:\/\/[^/]+\//, '(') ?? '' : '';
  el.textContent = `Something went wrong: ${msg} ${where} — the game kept running. A screenshot of this note helps us fix it.`;
  el.classList.remove('hidden');
  clearTimeout((el as any)._t);
  (el as any)._t = setTimeout(() => el!.classList.add('hidden'), 15000);
}

/** Frame-section profiler (debug API only): where does each frame's CPU time go, and which frames spike? */
const prof = {
  on: false, t0: 0, last: 0, cur: {} as Record<string, number>, frames: [] as { total: number; s: Record<string, number> }[],
  begin() { if (!this.on) return; this.cur = {}; this.t0 = this.last = performance.now(); },
  mark(n: string) { if (!this.on) return; const t = performance.now(); this.cur[n] = (this.cur[n] ?? 0) + t - this.last; this.last = t; },
  progs: 0, compiled: [] as string[],
  end() {
    if (!this.on) return;
    this.frames.push({ total: performance.now() - this.t0, s: this.cur });
    if (this.frames.length > 2000) this.frames.shift();
    // shader programs compiled during this frame (a mid-game compile is a hitch)
    const ps = (renderer.info.programs ?? []) as { name: string; cacheKey: string }[];
    if (ps.length > this.progs) for (const pr of ps.slice(this.progs)) this.compiled.push(`${pr.name || '?'} [${(pr.cacheKey || '').slice(0, 60)}]`);
    this.progs = ps.length;
  },
};

const FIX = 1 / 60;
let acc = 0;
let last = performance.now();
let upsideT = 0;
let bigMap = false;
let spatialT = 0, lockBeepT = 0, lastDeliveries = -1, shownRep = NaN;
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

  prof.begin();
  if (state === 'playing') {
    try {
    if (campaign.state === 'results') { for (const k of ['Enter', 'KeyF']) if (input.consume(k) && campaign.resultsKey(k)) break; }
    if (conv.active) {
      if (input.consume('Escape')) conv.leave();
      for (const k of ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3']) if (input.consume(k)) conv.key(k);
    }
    if (input.consume('Escape') || input.consume('KeyP')) { pause(); input.endFrame(); }
    if (interiors.active && mode !== 'foot') exitPlace();
    if (input.consume('KeyC')) { chase.mode = chase.mode === 'chase' ? 'far' : chase.mode === 'far' ? 'hood' : 'chase'; save.settings.cam = chase.mode; writeSave(save); }
    if (input.consume('KeyR') && mode === 'drive') resetCar();
    if (input.consume('KeyM')) { bigMap = !bigMap; show('bigmap', bigMap); }
    const driving = mode === 'drive';
    handleInteractions();
    const inp = driving ? input.read(dtReal) : PARK;
    if (seqDone) { seqT -= dtReal; if (seqT <= 0) { const f = seqDone; seqDone = null; f(); } }
    talking = Math.max(0, talking - dtReal);
    hitCooldown = Math.max(0, hitCooldown - dtReal);
    if (subT > 0) { subT -= dtReal; if (subT <= 0) $('subtitle').classList.add('hidden'); }
    prof.mark('input');
    if (!interiors.active) traffic.update(dtReal, mode === 'drive' ? carPos : playerPos, carVel, vehicle.body);
    prof.mark('traffic');
    acc += dtReal;
    let steps = 0;
    while (acc >= FIX && steps < 6) {
      vehicle.step(FIX, inp);
      for (const pc of parkedCars) pc.vehicle.step(FIX, PARK);
      phys.world.step(eventQueue);
      eventQueue.drainContactForceEvents((e) => {
        const c1 = phys.world.getCollider(e.collider1()), c2 = phys.world.getCollider(e.collider2());
        const other = c1.parent()?.handle === vehicle.body.handle ? c2 : c1;
        impact(e.totalForceMagnitude(), other);
      });
      acc -= FIX;
      steps++;
    }
    prof.mark('physics');
    vehicle.getTransform(carPos, carQuat);
    const lv = vehicle.body.linvel();
    carVel.set(lv.x, lv.y, lv.z);
    // fell out of the world or flipped: reset
    if (carPos.y < -5) resetCar();
    if (vehicle.isUpsideDown() && vehicle.speedAbs < 2) { upsideT += dtReal; if (upsideT > 2) { resetCar(); upsideT = 0; } } else upsideT = 0;

    car.update(dtReal, vehicle, carPos, carQuat, inp.throttle);
    car.beams.visible = chase.mode !== 'hood' || !driving;
    for (const pc of parkedCars) {
      const pp = new THREE.Vector3(), pq = new THREE.Quaternion();
      pc.vehicle.getTransform(pp, pq);
      pc.car.update(dtReal, pc.vehicle, pp, pq, 0);
    }
    prof.mark('cars');
    // the hero on foot (also during get-in / get-out animations)
    if (hero && hero.active) hero.update(dtReal, mode === 'foot' ? input.readFoot() : { x: 0, z: 0, run: false, jump: false }, footCam.yaw);
    updateCarSeq(dtReal);
    if (driving || !hero) {
      playerPos.copy(carPos); playerVel.copy(carVel);
      chase.update(dtReal, carPos, carQuat, carVel, vehicle.speed, vehicle.boosting, vehicle.drifting, vehicle.body);
    } else {
      const hp = hero.pos;
      playerVel.copy(hp).sub(playerPos).divideScalar(Math.max(dtReal, 1e-3)).setY(0);
      playerPos.copy(hp);
      footCam.update(dtReal, hp, input.keys, hero.collider);
    }
    prof.mark('hero+cam');
    probeHook?.(dtReal);
    if (interiors.active) interiors.update(dtReal);
    else crowd.update(dtReal, playerPos, driving ? { pos: carPos, vel: carVel, halfLen: car.dims.length / 2, halfWid: car.dims.width / 2, yaw: vehicle.yaw(), speed: vehicle.speedAbs } : null);
    if (conv.active) conv.update(dtReal, camera);
    society.update(dtReal);
    barks.update(dtReal, playerPos, mode === 'foot', playerVel.length(), police.heat > 0);
    if (save.deliveries !== lastDeliveries) { if (lastDeliveries >= 0 && save.deliveries > lastDeliveries) society.repEvent('delivery', playerPos); lastDeliveries = save.deliveries; }
    prof.mark('crowd');
    const pol = police.update(dtReal, simTime, streetPos(), interiors.active ? new THREE.Vector3() : playerVel, !driving, !!interiors.active);
    prof.mark('police');
    audio.siren(pol.nearestPos && pol.nearest < 160 ? pol.nearestPos : null);
    missions.update(dtReal, simTime, playerPos, playerVel, driving ? vehicle.speedAbs : playerVel.length(), driving && vehicle.drifting, traffic.cars, () => {
      chase.impact(0.6);
      audio.play('hit_metal', { volume: 0.8 });
      vehicle.body.applyImpulse({ x: (Math.random() - 0.5) * 3000, y: 2500, z: (Math.random() - 0.5) * 3000 }, true);
    });
    campaign.update({ dt: dtReal, t: simTime, pos: playerPos, vel: playerVel, speed: driving ? vehicle.speedAbs : playerVel.length(), drifting: driving && vehicle.drifting, driving, onFoot: mode === 'foot', heat: police.heat, traffic: traffic.cars });
    prof.mark('missions');
    if (driving) emitEffects(dtReal);
    prof.mark('effects');
    // audio
    const slip = Math.max(...vehicle.wheels.map((w) => (w.contact ? Math.abs(w.slipLat) + w.slipLong * 0.5 : 0)));
    if (driving) audio.updateEngine(vehicle.rpm, inp.throttle, vehicle.speedAbs, slip, vehicle.drifting, vehicle.boosting);
    else audio.updateEngine(850, 0, 0, 0, false, false);
    if (vehicle.boosting && !(vehicle as any)._wasBoost) audio.play('boost', { volume: 0.8 });
    (vehicle as any)._wasBoost = vehicle.boosting;
    audio.updateListener(camera);
    audio.setPos(audio.trainLoop, train.position, 1.0);
    const obj = objective();
    let nearestDrone: (typeof obj.drones)[number] | undefined, nd = Infinity;
    for (const d of obj.drones) { const k = d.mesh.position.distanceToSquared(playerPos); if (k < nd) { nd = k; nearestDrone = d; } }
    audio.setPos(audio.droneLoop, nearestDrone ? nearestDrone.mesh.position : new THREE.Vector3(0, -999, 0), nearestDrone ? 0.8 : 0);
    // lock-on warning: beeps speed up as a drone's lock builds
    const lock = Math.max(0, ...obj.drones.map((d) => d.lock / Drone.LOCK_TIME));
    lockBeepT -= dtReal;
    if (lock > 0.05 && lockBeepT <= 0) { audio.play('timer_warning', { volume: 0.45 }); lockBeepT = 0.32 - lock * 0.22; }
    spatialT -= dtReal;
    if (spatialT <= 0) { spatialT = 0.5; audio.updateSpatial(city.sounds, camera.position); audio.sirens(0.12 + 0.1 * Math.sin(simTime * 0.05)); }
    prof.mark('audio');
    // HUD
    const sp = streetPos();
    const d = districtAt(sp.x, sp.z);
    if ((save.rep[d] ?? 0) !== shownRep || d !== lastDistrict) { shownRep = save.rep[d] ?? 0; hud.setRep(shownRep, repLabel(shownRep)); }
    if (d !== lastDistrict) { hud.setDistrict(d); if (lastDistrict && save.unlocked.includes(d)) audio.say(({ neon: 'brief_neon', backstreets: 'brief_back', downtown: 'brief_downtown', docks: 'brief_docks' } as const)[d]); lastDistrict = d; }
    document.querySelector('.hud-br')!.classList.toggle('hidden', !driving);
    if (driving) hud.drawSpeedo(Math.abs(vehicle.speed) * 3.6, vehicle.rpm, vehicle.speed < -0.5 ? 0 : vehicle.gear, vehicle.boost, vehicle.boosting);
    const yaw = driving || !hero ? vehicle.yaw() : hero.person.yaw;
    hud.drawMinimap(playerPos, yaw, obj.target, obj.route, [...obj.drones.map((q) => q.mesh.position), ...police.units.map((u) => u.pos)], obj.kind, society.jobMarkers());
    if (bigMap) hud.drawBigMap(playerPos, yaw, obj.target, obj.route);
    hud.arrow(camera, obj.target, obj.kind === 'drop' ? '#ff2fb4' : '#21f3ff');
    hud.tick(dtReal);
    prof.mark('hud');
    adaptiveQuality(dtReal);
    input.endFrame();
    } catch (e) { reportFrameError(e); input.endFrame(); }
  } else if (state === 'title') {
    // slow orbit for the background (hidden behind the intro video)
    camera.position.set(SPAWN.x + Math.sin(simTime * 0.1) * 20, 6, SPAWN.z + Math.cos(simTime * 0.1) * 20);
    camera.lookAt(SPAWN);
  }
  if (state === 'title') return; // the title screen is a video; skip 3D rendering

  // world updates shared by playing/paused
  if (state === 'playing') try {
    train.update(dtReal);
    skyTraffic.update(simTime, camera.position);
    sky.update(camera, simTime);
    rain.update(camera, playerVel, innerHeight * Q.pixelRatio);
    splashes.update(camera);
    fogLayers.update(dtReal, camera.position, 1);
    smoke.update(dtReal);
    sparks.update(dtReal);
    city.updateVisibility(camera.position, Q.viewDistance);
    prof.mark('world');
    updateLightPools();
    prof.mark('lightpools');
    const s = Math.min(1, vehicle.speedAbs / 60);
    (post.lens as any).set(simTime, Q.lensFx ? 0.55 * (1 - s * 0.6) : 0, (vehicle.boosting ? 0.6 : 0) * Math.min(1, vehicle.speedAbs / 30) + (s > 0.6 ? (s - 0.6) * 1.2 : 0));
    post.chroma.offset.set(0.0006 + (vehicle.boosting ? 0.0025 : 0), 0.0004 + (vehicle.boosting ? 0.0015 : 0));
  } catch (e) { reportFrameError(e); }
  renderer.info.reset();
  // car reflection probe: one cube face per frame (High) or every other frame (Med), off on Low.
  // Rendering all six faces at once every few frames caused visible hitches.
  if (state === 'playing' && cubeCam && cubeRT && car.paintMat && qLevel !== 'low') {
    const tick = cubeFrame++;
    if (tick === 0) { cubeCam.position.copy(carPos).add(new THREE.Vector3(0, 1.2, 0)); car.root.visible = false; cubeCam.update(renderer, scene); car.root.visible = true; }
    else if (qLevel === 'high' || tick % 2 === 0) {
      const face = cubeFace++ % 6;
      if (face === 0) { cubeCam.position.copy(carPos).add(new THREE.Vector3(0, 1.2, 0)); cubeCam.updateMatrixWorld(true); }
      car.root.visible = false;
      const prev = renderer.getRenderTarget();
      cubeRT.texture.generateMipmaps = face === 5;
      renderer.setRenderTarget(cubeRT, face);
      renderer.render(scene, cubeCam.children[face] as THREE.Camera);
      renderer.setRenderTarget(prev);
      car.root.visible = true;
      if (face === 5) cubeRT.texture.needsPMREMUpdate = true;
    }
    if (car.paintMat.envMap !== cubeRT.texture) { car.paintMat.envMap = cubeRT.texture; car.paintMat.envMapIntensity = 1.3; car.paintMat.needsUpdate = true; }
  } else if (car && car.paintMat && cubeRT && car.paintMat.envMap === cubeRT.texture && qLevel === 'low') {
    car.paintMat.envMap = scene.environment; car.paintMat.needsUpdate = true;
  }
  prof.mark('cubemap');
  reflector.update(renderer, scene, camera);
  prof.mark('reflection');
  post.render(dtReal);
  prof.mark('render');
  prof.end();

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
    mode: () => mode,
    exitCar: () => startExit(),
    enterCar: () => startEnter(),
    talk: () => talkTo(),
    conv: () => ({ active: !!conv.active, name: document.getElementById('cv-name')!.textContent, tag: document.getElementById('cv-tag')!.textContent, line: document.getElementById('cv-line')!.textContent, replies: [...document.querySelectorAll('#cv-replies .cv-reply')].map((b) => b.textContent), persona: conv.persona, heroBusy: hero?.busy ?? 0 }),
    convSay: (text: string) => conv.say(text),
    heroToDoor: (id: string) => { const ps = society.places.get(id)!; hero?.place(ps.stand.clone().add(new THREE.Vector3(ps.spot.nx, 0, ps.spot.nz).multiplyScalar(0.8)).setY(0.2)); return ps.stand.toArray(); },
    enterPlace: (id: string) => enterPlace(id),
    exitPlace: () => exitPlace(),
    indoors: () => interiors.active ? { place: interiors.active.placeId, people: interiors.active.people.map((q) => ({ type: q.type, role: q.role, key: q.key ?? null })), hero: hero?.pos.toArray().map((n) => +n.toFixed(1)), counter: interiors.active.counter.toArray().map((n) => +n.toFixed(1)), heat: police.heat } : null,
    heroToCounter: () => { if (interiors.active && hero) hero.place(interiors.active.counter.clone().setY(0.2)); },
    convAccept: () => (document.querySelector('#cv-replies .cv-reply.accept') as HTMLButtonElement | null)?.click(),
    regulars: () => [...society.places.values()].length && REGULARS.map((r) => ({ key: r.key, home: r.home, at: society.places.get(r.home)?.stand.toArray().map((n) => Math.round(n)), present: !!crowd.byKey(regularId(r)) })),
    heroToRegular: (key: string) => {
      const r = REGULARS.find((q) => q.key === key)!;
      const ps = society.places.get(r.home)!;
      society.update(1);
      hero?.place(ps.stand.clone().add(new THREE.Vector3(ps.spot.nx, 0, ps.spot.nz).multiplyScalar(1.4)));
      return ps.stand.toArray();
    },
    social: () => ({ job: society.active ? { title: society.active.def.title, pay: society.active.pay, giver: society.active.giverName } : null, story: campaign.active?.id ?? null, steps: campaign.steps.length, step: campaign.idx, target: campaign.target?.toArray().map((n) => Math.round(n)), rep: { ...save.rep }, npc: JSON.parse(JSON.stringify(save.npc)), credits: save.credits, markers: society.jobMarkers().length }),
    convLeave: () => conv.leave(),
    personaSample: (n: number) => crowd.peds.slice(0, n).map((p) => conv.personaOf(p)),
    heat: (n: number) => police.add(n, 'debug'),
    /** who is inside a building right now (a fixed collider at chest height) */
    wallCheck: () => {
      const inWall = (x: number, z: number) => {
        let hit: string | null = null;
        phys.world.intersectionsWithPoint({ x, y: 1.0, z }, (c) => { const b = c.parent(); if (b && b.isFixed() && !c.isSensor()) { const h = c.halfExtents?.(); hit = h ? `box ${h.x.toFixed(1)}x${h.z.toFixed(1)}` : 'shape'; return false; } return true; });
        return hit;
      };
      const out: string[] = [];
      for (const p of crowd.peds) { const h = inWall(p.pos.x, p.pos.z); if (h) out.push(`ped ${p.type} ${p.state} at ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)} in ${h}`); }
      for (const u of police.units) { const h = inWall(u.pos.x, u.pos.z); if (h) out.push(`police at ${u.pos.x.toFixed(1)},${u.pos.z.toFixed(1)} in ${h}`); }
      for (const c of traffic.cars) { const h = inWall(c.pos.x, c.pos.z); if (h) out.push(`traffic at ${c.pos.x.toFixed(1)},${c.pos.z.toFixed(1)} in ${h}`); }
      return { peds: crowd.peds.length, police: police.units.length, traffic: traffic.cars.length, inside: out };
    },
    panicNear: (r: number) => crowd.panic(playerPos, r),
    clearHeat: () => police.clear(),
    peds: () => crowd.peds.map((p) => ({ type: p.type, state: p.state, d: +p.pos.distanceTo(playerPos).toFixed(1) })).sort((a, b) => a.d - b.d).slice(0, 6),
    heroTo: (x: number, z: number) => hero?.place(new THREE.Vector3(x, 0.2, z)),
    nearestPed: () => { const p = crowd.peds.slice().sort((a, b) => a.pos.distanceTo(playerPos) - b.pos.distanceTo(playerPos))[0]; return p ? p.pos.toArray() : null; },
    camYaw: (y: number) => { footCam.yaw = y; },
    toTrafficDoor: () => {
      const c = traffic.nearestCar(playerPos, 400);
      if (!c || !hero) return null;
      c.stunned = 30; // hold it still for the test
      const door = carDoor(c.pos, c.yaw, (traffic.models[c.model]?.width ?? 1.9) / 2);
      hero.place(door.clone().add(new THREE.Vector3(Math.sin(c.yaw + Math.PI / 2), 0, Math.cos(c.yaw + Math.PI / 2)).multiplyScalar(0.8)));
      footCam.yaw = c.yaw + Math.PI / 2 + 0.6;
      return { model: traffic.models[c.model]?.id, door: door.toArray() };
    },
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
    story: (id: string) => { const d = MISSIONS.find((m) => m.id === id); if (d) startStory(d); return !!d; },
    storyState: () => ({ id: campaign.active?.id, state: campaign.state, step: campaign.idx, steps: campaign.steps.length, timer: campaign.timer, target: campaign.target?.toArray().map((n) => Math.round(n)), damage: Math.round(campaign.damage), comfort: Math.round(campaign.comfort), drift: Math.round(campaign.driftBank + campaign.driftChain), heat: police.heat, mode }),
    /** raw per-frame world positions of both hero feet (for checking that a planted foot stays put) */
    footTrace: (frames = 16) => new Promise((done) => {
      if (!hero) return done(null);
      const f: THREE.Object3D[] = [];
      hero.person.root.traverse((o) => { if (/(left|right)foot$/i.test(o.name)) f.push(o); });
      const out: string[] = [];
      let n = 0;
      probeHook = () => {
        const p = f.map((o) => o.getWorldPosition(new THREE.Vector3()));
        out.push(p.map((v, i) => `${i ? 'R' : 'L'}(${v.x.toFixed(2)},${v.z.toFixed(2)} h${(v.y - hero!.pos.y).toFixed(2)})`).join(' '));
        if (++n >= frames) { probeHook = null; done(out); }
      };
    }),
    heroYaw: () => hero?.person.yaw ?? 0,
    /** start/stop the frame profiler; stop returns per-section averages, max, and the 5 worst frames */
    profile: (on: boolean) => {
      if (on) { prof.frames = []; prof.compiled = []; prof.progs = (renderer.info.programs ?? []).length; prof.on = true; return true; }
      prof.on = false;
      const F = prof.frames, keys = [...new Set(F.flatMap((f) => Object.keys(f.s)))];
      const avg = Object.fromEntries(keys.map((k) => [k, +(F.reduce((a, f) => a + (f.s[k] ?? 0), 0) / Math.max(1, F.length)).toFixed(2)]));
      const max = Object.fromEntries(keys.map((k) => [k, +Math.max(...F.map((f) => f.s[k] ?? 0)).toFixed(1)]));
      const worst = [...F].sort((a, b) => b.total - a.total).slice(0, 5).map((f) => ({ total: +f.total.toFixed(1), top: Object.entries(f.s).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') }));
      return { frames: F.length, avg, max, worst, compiledDuringPlay: prof.compiled };
    },
    /** time UI actions that run inside tap/click handlers */
    timeActions: () => {
      const t = (f: () => void) => { const a = performance.now(); f(); return +(performance.now() - a).toFixed(1); };
      return {
        applyCustomization: t(() => applyCustomization()),
        applyCustomizationAgain: t(() => applyCustomization()),
        spawnSameCar: t(() => spawnPlayerCar(carId, carPos.clone().setY(0.8), vehicle.yaw())),
        storyMenu: t(() => { openStory(); show('story', false); }),
      };
    },
    rainInfo: () => {
      const u = rain.uniforms, g = rain.mesh.geometry as THREE.InstancedBufferGeometry;
      return { inScene: !!rain.mesh.parent, visible: rain.mesh.visible, layers: rain.mesh.layers.mask, camLayers: camera.layers.mask, instanceCount: g.instanceCount, index: g.index?.count,
        cam: u.uCam.value.toArray().map((v) => +v.toFixed(1)), camVel: u.uCamVel.value.toArray().map((v) => +v.toFixed(2)), px: u.uPx.value, gain: u.uGain.value, time: +u.uTime.value.toFixed(2),
        programs: (renderer.info.programs ?? []).filter((p: any) => /ShaderMaterial/.test(p.name)).length, calls: renderer.info.render.calls };
    },
    policeInfo: () => ({ heat: police.heat, units: police.units.map((u) => +u.pos.distanceTo(playerPos).toFixed(1)), upright: !vehicle.isUpsideDown(), up: +new THREE.Vector3(0, 1, 0).applyQuaternion(carQuat).y.toFixed(2), kmh: +(vehicle.speedAbs * 3.6).toFixed(0) }),
    storyInteract: () => { campaign.interaction?.run(); return !!campaign.interaction; },
    storyNext: () => { (campaign as any).next(); },
    /** on foot: stand at the driver door of the player's own car */
    heroToOwnDoor: () => {
      if (!hero) return null;
      const door = carDoor(carPos, vehicle.yaw(), car.dims.width / 2);
      hero.place(door.clone().setY(0.2));
      footCam.yaw = vehicle.yaw() + Math.PI / 2 + 0.6;
      return door.toArray().map(Math.round);
    },
    /** on foot: stand at the driver door of the most recently parked car */
    toParkedDoor: () => {
      const p = parkedCars[parkedCars.length - 1];
      if (!p || !hero) return null;
      const t = p.vehicle.body.translation();
      const door = carDoor(new THREE.Vector3(t.x, 0, t.z), p.vehicle.yaw(), p.car.dims.width / 2);
      hero.place(door.clone().setY(0.2));
      footCam.yaw = p.vehicle.yaw() + Math.PI / 2 + 0.5;
      return door.toArray().map(Math.round);
    },
    /** teleport the player (car or on foot) onto the current story objective */
    storyWarp: (back = 0) => {
      const t = campaign.target;
      if (!t) return null;
      const dir = playerPos.clone().sub(t).setY(0);
      if (dir.lengthSq() < 1) dir.set(1, 0, 0);
      dir.normalize();
      const p = t.clone().addScaledVector(dir, back);
      if (mode !== 'drive' && hero) hero.place(new THREE.Vector3(p.x, 0.2, p.z));
      else { vehicle.reset(new THREE.Vector3(p.x, 0.8, p.z), Math.atan2(-dir.x, -dir.z)); chase.snap(); }
      return [Math.round(p.x), Math.round(p.z)];
    },
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
Promise.all(['signs', 'ads', 'shops'].map((n) => fetch(av(`./assets/atlas/${n}.json`)).then((r) => r.json()))).then(([signs, ads, shops]) => {
  atlasJson = { signs, ads, shops };
  boot().catch((e) => { console.error(e); $('loadlabel').textContent = `Error: ${e.message}`; });
  requestAnimationFrame(frame);
});
