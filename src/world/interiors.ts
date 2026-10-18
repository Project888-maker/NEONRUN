// Shop interiors: a small room behind the door of every named place. Built on first visit away from
// the city (the city is hidden while you are inside), with photographed walls behind real 3D counters
// and props, its own lamps, a person behind the counter and a few customers.
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Physics } from '../core/physics';
import { av } from '../core/version';
import { Person } from './people';
import type { PlaceSpot } from '../npc/regulars';

export type RoomType = 'food' | 'market' | 'shop' | 'clinic' | 'lobby' | 'depot';
export const PLACE_ROOM: Record<string, RoomType> = {
  noodle_row: 'food', fish_market: 'market', night_market: 'market', arcade: 'shop', laundromat: 'shop', tattoo: 'shop',
  clinic: 'clinic', tower: 'lobby', hotel: 'lobby', courthouse: 'lobby', pier9: 'depot', union_hall: 'depot',
};
/** who works the counter when the place has no regular */
const CLERK: Record<RoomType, string[]> = {
  food: ['ped_vendor'], market: ['ped_vendor', 'ped_elder'], shop: ['ped_punk', 'ped_techwear'], clinic: ['ped_nurse'], lobby: ['ped_suit'], depot: ['ped_worker'],
};
const CUSTOMERS: Record<RoomType, string[]> = {
  food: ['ped_worker', 'ped_student', 'ped_rider', 'ped_punk'], market: ['ped_elder', 'ped_student', 'ped_worker'], shop: ['ped_student', 'ped_punk', 'ped_techwear', 'ped_rider'],
  clinic: ['ped_elder', 'ped_worker', 'ped_student'], lobby: ['ped_suit', 'ped_techwear', 'ped_nurse'], depot: ['ped_worker', 'ped_rider'],
};
const STYLE: Record<RoomType, { floor: number; counter: number; top: number; light: number; light2: number; glossy: boolean }> = {
  food: { floor: 0x8a7a6a, counter: 0x3a2618, top: 0x6b4a2e, light: 0xffb36b, light2: 0xff4a3a, glossy: false },
  market: { floor: 0x6f7270, counter: 0x4a3a28, top: 0x7a6040, light: 0xfff0c8, light2: 0x7affc8, glossy: false },
  shop: { floor: 0x55525a, counter: 0x15161c, top: 0x2b2d36, light: 0xd060ff, light2: 0x21f3ff, glossy: true },
  clinic: { floor: 0xb8c0c4, counter: 0xdfe6ea, top: 0xf2f6f8, light: 0xe8f4ff, light2: 0x7fd8ff, glossy: true },
  lobby: { floor: 0x24262c, counter: 0x0f1014, top: 0x3a3c44, light: 0xfff1d8, light2: 0xffc070, glossy: true },
  depot: { floor: 0x6a6660, counter: 0x3d4248, top: 0x5c636b, light: 0xffd8a0, light2: 0xff9a30, glossy: false },
};

const W = 12, D = 9, H = 4; // room size (m)

export interface RoomPerson {
  id: number; type: string; p: Person; pos: THREE.Vector3; state: string; t: number; key?: string; prevState?: string;
  inside: string; role: 'clerk' | 'customer'; roomType: RoomType; homeYaw: number;
}
export interface Room {
  placeId: string; type: RoomType; group: THREE.Group; origin: THREE.Vector3;
  /** where you appear on entering, facing in */ spawn: THREE.Vector3; spawnYaw: number;
  /** stand here to leave */ exit: THREE.Vector3;
  /** the customer side of the counter: hand-overs and pickups happen here */ counter: THREE.Vector3;
  lights: { pos: THREE.Vector3; color: THREE.Color; radius: number }[];
  people: RoomPerson[];
}

export interface InteriorHost {
  phys: Physics; scene: THREE.Scene; people: Record<string, GLTF>;
  places: Map<string, PlaceSpot>;
  /** the regular who works here, if any: [model type, key] */
  regularAt(placeId: string): { type: string; key: string } | null;
}

let nextId = 800000;
/** Each wall loads its own copy (the browser cache shares the download) so per-wall cropping is safe. */
function photo(name: string) {
  const t = new THREE.TextureLoader().load(av(`./assets/interior/${name}.webp`));
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A photographed wall: mostly self-lit (the photo carries its own lighting), a little room light on top. */
function photoWall(name: string, w: number, h: number, aspect: number, mirror = false) {
  const t = photo(name);
  // crop the photo to the wall's proportions instead of stretching it
  const wallAspect = w / h;
  if (wallAspect > aspect) { t.repeat.set(1, aspect / wallAspect); t.offset.set(0, (1 - aspect / wallAspect) * 0.45); }
  else { t.repeat.set(wallAspect / aspect, 1); t.offset.set((1 - wallAspect / aspect) / 2, 0); }
  if (mirror) { t.wrapS = THREE.RepeatWrapping; t.repeat.x *= -1; t.offset.x = 1 - t.offset.x; }
  const m = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.62, color: 0x777777, roughness: 0.85 });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}

export class Interiors {
  rooms = new Map<string, Room>();
  active: Room | null = null;
  /** door frames + name signs on the street side */
  doors = new THREE.Group();
  private slot = 0;

  constructor(private h: InteriorHost) {
    for (const [id, ps] of h.places) this.doors.add(this.doorFrame(id, ps));
  }

  /** where you stand on the street to go in (the sidewalk in front of the shopfront) */
  entrance(placeId: string) { return this.h.places.get(placeId)!.stand; }

  /** nearest door you could walk through from here */
  nearestDoor(pos: THREE.Vector3, r = 2.4): string | null {
    let best: string | null = null, bd = r;
    for (const [id, ps] of this.h.places) {
      const d = Math.hypot(ps.stand.x - pos.x, ps.stand.z - pos.z);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  room(placeId: string): Room {
    let r = this.rooms.get(placeId);
    if (!r) { r = this.build(placeId); this.rooms.set(placeId, r); }
    return r;
  }

  /** A lit doorway with the place's name above it, on the shopfront. */
  private doorFrame(id: string, ps: PlaceSpot) {
    const g = new THREE.Group();
    const n = new THREE.Vector3(ps.spot.nx, 0, ps.spot.nz);
    g.position.set(ps.spot.x - n.x * 4.42, 0, ps.spot.z - n.z * 4.42);
    g.rotation.y = Math.atan2(n.x, n.z);
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.5, 0.5) });
    for (const [x, y, w, hh] of [[-0.85, 1.25, 0.08, 2.5], [0.85, 1.25, 0.08, 2.5], [0, 2.5, 1.78, 0.08]] as const) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, 0.06), glow);
      b.position.set(x, y, 0);
      g.add(b);
    }
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 2.42), new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.15, metalness: 0.6, emissive: new THREE.Color(0.35, 0.22, 0.08), emissiveIntensity: 0.6 }));
    glass.position.set(0, 1.22, 0.01);
    g.add(glass);
    // name sign
    const c = document.createElement('canvas');
    c.width = 512; c.height = 96;
    const x = c.getContext('2d')!;
    x.fillStyle = 'rgba(0,0,0,0)'; x.fillRect(0, 0, 512, 96);
    x.font = '700 46px Orbitron, Rajdhani, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = '#ffb347'; x.shadowBlur = 18;
    x.fillStyle = '#ffe2b0';
    const name = ps.place.name.replace(/^the /, '').toUpperCase();
    x.fillText(name.length > 22 ? name.slice(0, 22) : name, 256, 50);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.49), new THREE.MeshBasicMaterial({ map: tex, transparent: true, color: new THREE.Color(1.8, 1.8, 1.8), depthWrite: false }));
    sign.position.set(0, 2.95, 0.03);
    g.add(sign);
    g.userData.placeId = id;
    return g;
  }

  private build(placeId: string): Room {
    const ps = this.h.places.get(placeId)!;
    const type = PLACE_ROOM[placeId] ?? 'shop';
    const type0 = type;
    const st = STYLE[type];
    const origin = new THREE.Vector3(5000 + (this.slot % 4) * 40, 0, 5000 + Math.floor(this.slot / 4) * 40);
    this.slot++;
    const g = new THREE.Group();
    g.position.copy(origin);
    const at = (x: number, y: number, z: number) => origin.clone().add(new THREE.Vector3(x, y, z));
    // walls: back (behind the counter) is this place's own photo, sides and windows by room type
    const back = photoWall(`${placeId}_back`, W, H, 2);
    back.position.set(0, H / 2, -D / 2);
    g.add(back);
    const left = photoWall(`${type}_side`, D, H, 1.5);
    left.position.set(-W / 2, H / 2, 0); left.rotation.y = Math.PI / 2;
    const right = photoWall(`${type}_side`, D, H, 1.5, true);
    right.position.set(W / 2, H / 2, 0); right.rotation.y = -Math.PI / 2;
    g.add(left, right);
    // front: windows either side of the door, dark wall around them
    const dark = new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.9 });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), dark);
    front.position.set(0, H / 2, D / 2); front.rotation.y = Math.PI;
    g.add(front);
    for (const sx of [-1, 1]) {
      const win = photoWall(`${type}_window`, 3.6, 2.2, 1.5, sx > 0);
      win.position.set(sx * 3.4, 1.75, D / 2 - 0.02); win.rotation.y = Math.PI;
      g.add(win);
    }
    const exitGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 0.8) });
    const doorGlass = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.4), new THREE.MeshStandardMaterial({ color: 0x05070c, emissive: new THREE.Color(0.08, 0.1, 0.18), roughness: 0.2, metalness: 0.5 }));
    doorGlass.position.set(0, 1.2, D / 2 - 0.03); doorGlass.rotation.y = Math.PI;
    const exitSign = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.2, 0.05), exitGlow);
    exitSign.position.set(0, 2.75, D / 2 - 0.06);
    g.add(doorGlass, exitSign);
    // floor + ceiling
    const floorMat = new THREE.MeshStandardMaterial({ color: st.floor, roughness: st.glossy ? 0.25 : 0.75, metalness: st.glossy ? 0.15 : 0 });
    const conc = new THREE.TextureLoader().load(av('./assets/tex/concrete_albedo.webp'));
    conc.wrapS = conc.wrapT = THREE.RepeatWrapping; conc.repeat.set(4, 3); conc.colorSpace = THREE.SRGBColorSpace;
    floorMat.map = conc;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), floorMat);
    floor.position.y = 0.001;
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 1 }));
    ceil.position.y = H;
    g.add(floor, ceil);
    // light strips / fittings on the ceiling and the lights they give off
    const lights: Room['lights'] = [];
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(st.light).multiplyScalar(2.4) });
    const accentMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(st.light2).multiplyScalar(2.2) });
    for (const [x, z] of [[-3, -1.8], [3, -1.8], [-3, 2], [3, 2]]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 0.25), lampMat);
      lamp.position.set(x, H - 0.05, z);
      g.add(lamp);
      lights.push({ pos: at(x, H - 0.6, z), color: new THREE.Color(st.light), radius: 9 });
    }
    const strip = new THREE.Mesh(new THREE.BoxGeometry(W - 1, 0.05, 0.05), accentMat);
    strip.position.set(0, H - 0.4, -D / 2 + 0.08);
    g.add(strip);
    lights.push({ pos: at(0, 2.2, -D / 2 + 1), color: new THREE.Color(st.light2), radius: 7 });
    // the counter
    const cz = -D / 2 + 2.2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(6, 1.0, 0.7), new THREE.MeshStandardMaterial({ color: st.counter, roughness: 0.6, metalness: st.glossy ? 0.3 : 0.05 }));
    body.position.set(0, 0.5, cz);
    const top = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.06, 0.85), new THREE.MeshStandardMaterial({ color: st.top, roughness: st.glossy ? 0.15 : 0.5, metalness: st.glossy ? 0.4 : 0.05 }));
    top.position.set(0, 1.03, cz);
    const kick = new THREE.Mesh(new THREE.BoxGeometry(6, 0.04, 0.04), accentMat);
    kick.position.set(0, 0.08, cz + 0.36);
    g.add(body, top, kick);
    this.props(type, g, cz);
    this.h.scene.add(g);
    // physics: floor, walls, counter
    const P = this.h.phys;
    P.box(origin.x, -0.25, origin.z, W / 2 + 1, 0.25, D / 2 + 1, 0, 0.9);
    P.box(origin.x, H / 2, origin.z - D / 2 - 0.2, W / 2 + 1, H / 2, 0.2);
    P.box(origin.x, H / 2, origin.z + D / 2 + 0.2, W / 2 + 1, H / 2, 0.2);
    P.box(origin.x - W / 2 - 0.2, H / 2, origin.z, 0.2, H / 2, D / 2 + 1);
    P.box(origin.x + W / 2 + 0.2, H / 2, origin.z, 0.2, H / 2, D / 2 + 1);
    P.box(origin.x, 0.55, origin.z + cz, 3.1, 0.55, 0.42);
    P.box(origin.x, H + 0.2, origin.z, W / 2 + 1, 0.2, D / 2 + 1);
    // people: whoever runs the place behind the counter, a few customers
    const people: RoomPerson[] = [];
    const reg = this.h.regularAt(placeId);
    const pick = <T>(a: T[], k: number) => a[(placeId.length * 7 + k * 13) % a.length];
    const add = (type: string, x: number, z: number, yaw: number, role: RoomPerson['role'], anim: 'idle' | 'phone', key?: string) => {
      const gl = this.h.people[type];
      if (!gl) return;
      const p = new Person(gl, type);
      const pos = at(x, 0, z);
      p.place(pos.x, 0, pos.z, yaw);
      p.play(anim, { fade: 0 });
      p.mixer.setTime((x + z) % 3);
      this.h.scene.add(p.root);
      people.push({ id: nextId++, type, p, pos, state: anim, t: 1e9, key, inside: placeId, role, roomType: type0, homeYaw: yaw });
    };
    add(reg?.type ?? pick(CLERK[type], 0), 0.4, cz - 0.95, 0, 'clerk', 'idle', reg?.key);
    const cust = CUSTOMERS[type];
    add(pick(cust, 1), -3.8, -0.4, Math.PI * 0.6, 'customer', 'phone');
    add(pick(cust, 2), 3.6, 1.2, -Math.PI * 0.7, 'customer', 'idle');
    if (type === 'food' || type === 'clinic' || type === 'market') add(pick(cust, 3), -1.9, cz + 1.0, Math.PI, 'customer', 'idle');
    return {
      placeId, type, group: g, origin, people, lights,
      spawn: at(0, 0.2, D / 2 - 1.3), spawnYaw: Math.PI,
      exit: at(0, 0, D / 2 - 0.9),
      counter: at(0.4, 0, cz + 1.0),
    };
  }

  /** Simple set dressing per room type (cheap boxes and cylinders that give the photos depth). */
  private props(type: RoomType, g: THREE.Group, cz: number) {
    const mat = (c: number, r = 0.7, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); g.add(b); return b; };
    const cyl = (r: number, h: number, m: THREE.Material, x: number, y: number, z: number) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), m); c.position.set(x, y, z); g.add(c); return c; };
    if (type === 'food') {
      const chrome = mat(0xb8bcc4, 0.25, 0.9), seat = mat(0x8a1c1c, 0.5);
      for (let i = 0; i < 5; i++) { const x = -2.4 + i * 1.2; cyl(0.04, 0.72, chrome, x, 0.36, cz + 0.85); cyl(0.2, 0.08, seat, x, 0.76, cz + 0.85); }
      const lantern = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.5, 0.25) });
      for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), lantern); s.scale.y = 1.25; s.position.set(-2.7 + i * 1.8, 3.1, cz + 0.2); g.add(s); }
      const steel = mat(0x9aa0a8, 0.35, 0.8);
      cyl(0.32, 0.45, steel, 1.6, 1.28, cz - 0.05); cyl(0.26, 0.38, steel, -1.2, 1.25, cz - 0.05);
    } else if (type === 'market') {
      const wood = mat(0x6b4f30, 0.85);
      for (let i = 0; i < 6; i++) box(0.7, 0.45, 0.5, wood, -5 + (i % 3) * 0.75, 0.23 + Math.floor(i / 3) * 0.46, 1.8);
      for (let i = 0; i < 4; i++) box(0.6, 0.4, 0.45, wood, 4.6, 0.2 + i * 0.41, -0.8 + (i % 2) * 0.1);
      const tarp = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x2f6d8c, roughness: 0.8, side: THREE.DoubleSide }));
      tarp.position.set(0, 2.9, cz + 0.3); tarp.rotation.x = -Math.PI / 2.6; g.add(tarp);
    } else if (type === 'shop') {
      const metal = mat(0x2a2c33, 0.4, 0.6), goods = [mat(0xd9466a), mat(0x3ac2d6), mat(0xe8c14a), mat(0x6a4ad9)];
      for (const x of [-4.8, 4.8]) {
        box(0.5, 2.2, 2.4, metal, x, 1.1, 0.8);
        for (let k = 0; k < 9; k++) box(0.3, 0.25, 0.3, goods[k % 4], x + (x < 0 ? 0.12 : -0.12), 0.45 + Math.floor(k / 3) * 0.6, 0.0 + (k % 3) * 0.7);
      }
    } else if (type === 'clinic') {
      const seat = mat(0x2f8f8a, 0.5), leg = mat(0x9aa0a8, 0.3, 0.8);
      for (let i = 0; i < 4; i++) { box(0.5, 0.06, 0.5, seat, -4.6, 0.46, -1.5 + i * 0.6); box(0.06, 0.5, 0.5, seat, -4.88, 0.72, -1.5 + i * 0.6); }
      box(0.06, 0.44, 2.4, leg, -4.6, 0.22, -0.6);
      const cooler = mat(0xdfe8ee, 0.4);
      box(0.35, 1.1, 0.35, cooler, 4.9, 0.55, -2.4);
    } else if (type === 'lobby') {
      const marble = mat(0x1a1b20, 0.15, 0.2), brass = mat(0xc89a4a, 0.3, 0.9);
      box(2.4, 0.45, 0.6, marble, -3.6, 0.23, 1.5); box(2.4, 0.45, 0.6, marble, 3.6, 0.23, 1.5);
      for (const x of [-5, 5]) { cyl(0.35, 0.7, brass, x, 0.35, -2.8); const leaves = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.6, 9), mat(0x1f4a2c, 0.8)); leaves.position.set(x, 1.5, -2.8); g.add(leaves); }
    } else {
      const wood = mat(0x6e5236, 0.85), card = mat(0xa0784c, 0.9), hazard = mat(0xd8b21c, 0.6);
      box(1.2, 0.14, 1.0, wood, 3.8, 0.07, 1.6);
      for (let i = 0; i < 6; i++) box(0.5, 0.36, 0.4, card, 3.5 + (i % 2) * 0.55, 0.32 + Math.floor(i / 2) * 0.37, 1.6 + (i % 3) * 0.05);
      box(5.6, 0.02, 0.12, hazard, 0, 0.01, 1.0);
      for (let i = 0; i < 4; i++) box(0.55, 0.4, 0.45, card, -4.8, 0.2 + i * 0.41, -1.2 + (i % 2) * 0.15);
    }
  }

  /** Animate the people of the room you are in. */
  update(dt: number) {
    const r = this.active;
    if (!r) return;
    for (const q of r.people) {
      q.t -= dt;
      if (q.state === 'talk' && q.t <= 0) { q.state = q.prevState ?? 'idle'; q.t = 1e9; q.p.play(q.state === 'phone' ? 'phone' : 'idle', { fade: 0.5 }); }
      if (q.state !== 'talk') q.p.yaw = lerpYaw(q.p.yaw, q.homeYaw, dt * 3);
      q.p.place(q.pos.x, 0, q.pos.z, q.p.yaw);
      q.p.update(dt);
    }
  }

  /** Nearest person in the room you could talk to. */
  nearest(pos: THREE.Vector3, r: number) {
    let best: RoomPerson | null = null, bd = r;
    for (const q of this.active?.people ?? []) {
      const d = q.pos.distanceTo(pos);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }
}

function lerpYaw(a: number, b: number, k: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * Math.min(1, k);
}
