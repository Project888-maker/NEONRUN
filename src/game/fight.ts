// Street fighting on foot: the courier punches, jabs and kicks (motion-captured clips), can pick up a
// bottle or a pipe lying on the sidewalk, and people react: they recoil, go down, get back up and run,
// or (the tougher ones) square up and swing back. The courier has health that comes back out of combat;
// losing it all is a knockout.
import * as THREE from 'three';
import type { Crowd, Ped } from '../world/people';
import type { HeroOnFoot } from './onfoot';

export type Strike = 'punch' | 'jab' | 'kick';
type ItemKind = 'bottle' | 'pipe';
interface Item { kind: ItemKind; mesh: THREE.Mesh; held: boolean; uses: number }

/** moment of impact inside each clip (s at normal speed), from where the hand / foot is furthest out */
const IMPACT: Record<Strike, number> = { punch: 0.4, jab: 0.233, kick: 0.433 };
const REACH: Record<Strike, number> = { punch: 1.35, jab: 1.3, kick: 1.55 };
const DAMAGE: Record<Strike, number> = { punch: 22, jab: 14, kick: 32 };
const SPEED = 1.15; // strikes play a touch faster than captured: snappier to control
/** who squares up when hit (the rest run); per type, chance to fight back */
const FIGHT_BACK: Record<string, number> = { ped_punk: 0.85, ped_worker: 0.7, ped_rider: 0.6, ped_techwear: 0.55, ped_vendor: 0.3, ped_suit: 0.15, ped_student: 0.15, ped_nurse: 0.1, ped_elder: 0 };
const FEMALE = new Set(['ped_punk', 'ped_student', 'ped_nurse', 'ped_elder']);
const maxHp = (type: string) => (type === 'ped_elder' ? 45 : 100);

export interface FightHost {
  scene: THREE.Scene;
  crowd: Crowd;
  hero: () => HeroOnFoot | null;
  /** walkable sidewalk loops (for placing bottles and pipes) */
  walkRects: { x: number; z: number; hw: number; hd: number }[];
  sound(name: string, pos: THREE.Vector3, volume?: number): void;
  /** the courier hurt someone (first blow on them, or a knockout) */
  onAssault(victim: Ped, ko: boolean): void;
  /** someone speaks: 'taunt' (squaring up) or 'beg' (giving up) */
  say(victim: Ped, line: 'taunt' | 'beg'): void;
  /** the courier went down */
  onKnockout(): void;
  /** glass shards */
  shatter(pos: THREE.Vector3): void;
  later(sec: number, f: () => void): void;
}

export class Fight {
  heroHp = 100;
  /** seconds since the courier last took a hit (health comes back after a while) */
  private calm = 99;
  /** the combo alternates punch and jab; a third quick press throws a cross again */
  private combo = 0;
  private comboT = 0;
  weapon: Item | null = null;
  items: Item[] = [];
  private spawnT = 0;
  private koT = 0;
  private hand?: THREE.Object3D;
  private fore?: THREE.Object3D;

  constructor(private h: FightHost) {}

  get knockedOut() { return this.koT > 0; }

  /** The courier throws a strike (a weapon turns punches into swings with it). */
  attack(kind: 'punch' | 'kick') {
    const hero = this.h.hero();
    if (!hero || !hero.active || hero.frozen || hero.busy > 0 || !hero.grounded || this.koT > 0) return false;
    let strike: Strike = kind;
    if (kind === 'punch') {
      strike = this.weapon ? 'punch' : this.comboT > 0 && this.combo % 2 === 1 ? 'jab' : 'punch';
      this.combo = this.comboT > 0 ? this.combo + 1 : 1;
      this.comboT = 0.9;
    }
    // turn toward whoever is close in front (light aim assist, so swings land where you meant)
    const target = this.targetFor(hero, 2.6, 1.25);
    if (target) hero.person.yaw = Math.atan2(target.pos.x - hero.pos.x, target.pos.z - hero.pos.z);
    const d = hero.person.play(strike, { loop: false, fade: 0.08, speed: SPEED, restart: true });
    hero.busy = (d / SPEED) * 0.82;
    hero.guard = 4;
    this.h.sound('whoosh', hero.pos, 0.5);
    this.h.later(IMPACT[strike] / SPEED, () => this.land(strike));
    return true;
  }

  /** Pick up the nearest bottle or pipe, or drop the one in hand. */
  toggleItem() {
    const hero = this.h.hero();
    if (!hero || !hero.active || hero.frozen || this.koT > 0) return;
    if (this.weapon) {
      const it = this.weapon;
      it.held = false;
      this.weapon = null;
      it.mesh.position.copy(hero.pos).add(new THREE.Vector3(Math.sin(hero.person.yaw) * 0.5, 0.05, Math.cos(hero.person.yaw) * 0.5));
      this.lay(it.mesh);
      return;
    }
    const it = this.nearestItem(hero.pos, 1.7);
    if (!it) return;
    it.held = true;
    this.weapon = it;
    this.h.sound('pickup', hero.pos, 0.4);
  }

  nearestItem(pos: THREE.Vector3, r: number) {
    let best: Item | null = null, bd = r;
    for (const it of this.items) {
      if (it.held) continue;
      const d = Math.hypot(it.mesh.position.x - pos.x, it.mesh.position.z - pos.z);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  /** nearest standing person within `r` and inside the cone in front of the courier (cos of half angle) */
  private targetFor(hero: HeroOnFoot, r: number, cone: number) {
    const fx = Math.sin(hero.person.yaw), fz = Math.cos(hero.person.yaw);
    let best: Ped | null = null, bd = r;
    for (const p of this.h.crowd.peds) {
      if (p.state === 'down' || p.state === 'getup') continue;
      const dx = p.pos.x - hero.pos.x, dz = p.pos.z - hero.pos.z, d = Math.hypot(dx, dz);
      if (d > bd || d < 1e-3) continue;
      if ((dx * fx + dz * fz) / d < Math.cos(cone)) continue;
      bd = d; best = p;
    }
    return best;
  }

  /** the strike reaches out: hit whoever is there */
  private land(strike: Strike) {
    const hero = this.h.hero();
    if (!hero || !hero.active) return;
    const w = this.weapon;
    const p = this.targetFor(hero, REACH[strike] + (w ? 0.3 : 0), 0.95);
    if (!p) return;
    let dmg = DAMAGE[strike];
    let sound = strike === 'kick' ? 'kick_hit' : 'punch_hit';
    if (w) {
      dmg = w.kind === 'pipe' ? 42 : 38;
      sound = w.kind === 'pipe' ? 'pipe_hit' : 'bottle_smash';
      w.uses--;
      if (w.kind === 'bottle' || w.uses <= 0) {
        // the bottle breaks over them
        this.h.shatter(w.mesh.position.clone());
        this.h.scene.remove(w.mesh);
        this.items.splice(this.items.indexOf(w), 1);
        this.weapon = null;
      }
    }
    this.hit(p, dmg, hero.pos, sound);
  }

  /** someone takes a blow from the courier */
  hit(p: Ped, dmg: number, from: THREE.Vector3, sound = 'punch_hit') {
    const first = p.hp === undefined;
    p.hp = (p.hp ?? maxHp(p.type)) - dmg;
    p.p.hitReact(Math.min(1, dmg / 30));
    this.h.sound(sound, p.pos.clone().setY(1.4), 1);
    this.h.sound(FEMALE.has(p.type) ? 'grunt_f' : 'grunt_m', p.pos.clone().setY(1.6), 0.8);
    const away = p.pos.clone().sub(from).setY(0);
    if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
    away.normalize();
    if (p.hp <= 0) {
      p.ko = true;
      p.swing = undefined;
      p.state = 'down';
      p.t = 5 + Math.random() * 2;
      p.vel.copy(away).multiplyScalar(1.6);
      p.p.play('fall', { loop: false, fade: 0.08 });
      this.h.onAssault(p, true);
      return;
    }
    p.pos.addScaledVector(away, 0.22); // staggers back
    if (first) this.h.onAssault(p, false);
    if (p.state === 'fight') {
      if (p.hp < 30) this.giveUp(p, from);
      return;
    }
    if (Math.random() < (FIGHT_BACK[p.type] ?? 0.2) && p.hp > 40) {
      p.state = 'fight';
      p.swingCd = 0.7 + Math.random() * 0.5;
      p.p.play('fight_idle', { fade: 0.2 });
      this.h.say(p, 'taunt');
    } else this.giveUp(p, from);
  }

  private giveUp(p: Ped, from: THREE.Vector3) {
    p.swing = undefined;
    p.state = 'idle';
    this.h.say(p, 'beg');
    this.h.crowd.flee(p, from);
  }

  /** the courier takes a blow */
  private heroHit(dmg: number, from: THREE.Vector3) {
    const hero = this.h.hero();
    if (!hero || !hero.active || hero.frozen || this.koT > 0) return;
    this.heroHp -= dmg;
    this.calm = 0;
    const fx = Math.sin(hero.person.yaw), fz = Math.cos(hero.person.yaw);
    const front = (from.x - hero.pos.x) * fx + (from.z - hero.pos.z) * fz > 0;
    hero.person.hitReact(Math.min(1, dmg / 25), front);
    this.h.sound('punch_hit', hero.pos.clone().setY(1.4), 1);
    this.h.sound('grunt_m', hero.pos.clone().setY(1.6), 0.7);
    if (this.heroHp <= 0) this.knockout(hero);
  }

  private knockout(hero: HeroOnFoot) {
    this.heroHp = 0;
    this.koT = 5;
    hero.busy = 5;
    hero.guard = 0;
    hero.person.play('fall', { loop: false, fade: 0.1, restart: true });
    if (this.weapon) this.toggleItem();
    // everyone who was fighting walks off
    for (const p of this.h.crowd.peds) if (p.state === 'fight') { p.state = 'idle'; p.t = 2; p.swing = undefined; p.p.play('idle', { fade: 0.4 }); }
    this.h.later(2.2, () => this.h.onKnockout());
    this.h.later(2.6, () => {
      const hr = this.h.hero();
      if (!hr) return;
      const d = hr.person.play('get_up', { loop: false, fade: 0.2, restart: true });
      hr.busy = d;
      this.heroHp = 55;
    });
  }

  update(dt: number) {
    const hero = this.h.hero();
    this.comboT = Math.max(0, this.comboT - dt);
    this.koT = Math.max(0, this.koT - dt);
    this.calm += dt;
    if (this.calm > 5 && this.heroHp < 100) this.heroHp = Math.min(100, this.heroHp + 9 * dt);
    const onFoot = !!hero && hero.active;
    // people who were fighting, knocked down, or getting up
    for (const p of this.h.crowd.peds) {
      if (p.ko && p.state === 'down' && p.t <= 0) {
        p.state = 'getup';
        p.t = p.p.play('get_up', { loop: false, fade: 0.25, restart: true });
        p.hp = 30;
      } else if (p.state === 'getup' && p.t <= 0) {
        p.ko = false;
        p.state = 'idle';
        if (hero) this.h.crowd.flee(p, hero.pos);
      } else if (p.state === 'fight') this.brawler(p, dt, onFoot ? hero! : null);
    }
    this.updateItems(dt, hero);
  }

  /** a pedestrian squaring up: close in, keep guard, swing every second or two */
  private brawler(p: Ped, dt: number, hero: HeroOnFoot | null) {
    const done = () => { p.state = 'idle'; p.t = 2 + Math.random() * 2; p.swing = undefined; p.p.play('idle', { fade: 0.4 }); };
    if (!hero || this.koT > 0) { done(); return; }
    const dx = hero.pos.x - p.pos.x, dz = hero.pos.z - p.pos.z, d = Math.hypot(dx, dz);
    if (d > 14) { done(); return; }
    p.p.yaw = Math.atan2(dx, dz);
    if (p.swing) {
      p.swing.t += dt * SPEED;
      if (!p.swing.done && p.swing.t >= p.swing.hit) {
        p.swing.done = true;
        this.h.sound('whoosh', p.pos, 0.4);
        if (d < 1.5) this.heroHit(p.swing.kind === 'punch' ? 13 : 9, p.pos);
        if (!p.swing) return; // that blow knocked the courier out: everyone stood down
      }
      const dur = p.p.clipDuration(p.swing.kind);
      if (p.swing.t >= dur * 0.95) { p.swing = undefined; p.p.play('fight_idle', { fade: 0.15 }); }
      return;
    }
    if (d > 1.15) {
      const step = Math.min(d - 1.05, (d > 3 ? 3.2 : 1.6) * dt);
      p.pos.x += (dx / d) * step; p.pos.z += (dz / d) * step;
      const gait = d > 3 ? 'run' : 'walk';
      if (p.p.currentName !== gait) p.p.play(gait, { fade: 0.2, speed: p.p.gaitRate(gait, d > 3 ? 3.2 : 1.6) });
      return;
    }
    if (p.p.currentName !== 'fight_idle') p.p.play('fight_idle', { fade: 0.2 });
    p.swingCd = (p.swingCd ?? 1) - dt;
    if (p.swingCd <= 0) {
      const kind = Math.random() < 0.55 ? 'punch' : 'jab';
      p.p.play(kind, { loop: false, fade: 0.1, speed: SPEED, restart: true });
      p.swing = { t: 0, hit: IMPACT[kind], done: false, kind };
      p.swingCd = 1.1 + Math.random() * 0.9;
    }
  }

  // ---------------------------------------------------------------- bottles and pipes
  private updateItems(dt: number, hero: HeroOnFoot | null) {
    const at = hero?.active ? hero.pos : null;
    if (at && (this.spawnT -= dt) <= 0) {
      this.spawnT = 1.5;
      // drop far ones, keep a few lying around nearby
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (!it.held && it.mesh.position.distanceTo(at) > 80) { this.h.scene.remove(it.mesh); this.items.splice(i, 1); }
      }
      const near = this.items.filter((it) => !it.held && it.mesh.position.distanceTo(at) < 45).length;
      if (near < 5) this.spawnItem(at);
    }
    if (this.weapon && hero) this.holdInHand(this.weapon, hero);
  }

  /** put a bottle or pipe on the ground at `pos` (tests) */
  dropItemAt(kind: ItemKind, pos: THREE.Vector3) {
    const mesh = makeItem(kind);
    mesh.position.copy(pos);
    this.lay(mesh);
    this.h.scene.add(mesh);
    this.items.push({ kind, mesh, held: false, uses: kind === 'pipe' ? 8 : 1 });
  }

  private spawnItem(at: THREE.Vector3) {
    const rects = this.h.walkRects.filter((r) => Math.abs(r.x - at.x) < r.hw + 40 && Math.abs(r.z - at.z) < r.hd + 40);
    if (!rects.length) return;
    for (let tries = 0; tries < 8; tries++) {
      const r = rects[Math.floor(Math.random() * rects.length)];
      // a point on the loop, pushed toward the buildings (out of the walking line)
      const side = Math.floor(Math.random() * 4), u = Math.random() * 2 - 1;
      const inset = 0.9;
      const x = side < 2 ? r.x + u * r.hw : r.x + (side === 2 ? 1 : -1) * (r.hw - inset);
      const z = side < 2 ? r.z + (side === 0 ? 1 : -1) * (r.hd - inset) : r.z + u * r.hd;
      const d = Math.hypot(x - at.x, z - at.z);
      if (d < 10 || d > 40) continue;
      const kind: ItemKind = Math.random() < 0.6 ? 'bottle' : 'pipe';
      const mesh = makeItem(kind);
      mesh.position.set(x, 0.15, z);
      this.lay(mesh);
      this.h.scene.add(mesh);
      this.items.push({ kind, mesh, held: false, uses: kind === 'pipe' ? 8 : 1 });
      return;
    }
  }

  /** lying on the ground, at a random angle */
  private lay(m: THREE.Mesh) {
    m.position.y = 0.15 + (m.userData.radius ?? 0.03);
    m.quaternion.setFromEuler(new THREE.Euler(0, Math.random() * Math.PI * 2, Math.PI / 2, 'YXZ'));
  }

  /** gripped in the right fist: the bottle hangs from the neck along the forearm, the pipe points up from it */
  private holdInHand(it: Item, hero: HeroOnFoot) {
    if (!this.hand) hero.person.root.traverse((o) => { if (/^righthand$/i.test(o.name)) this.hand = o; if (/^rightforearm$/i.test(o.name)) this.fore = o; });
    if (!this.hand || !this.fore) return;
    const hp = this.hand.getWorldPosition(new THREE.Vector3());
    const fp = this.fore.getWorldPosition(new THREE.Vector3());
    const along = hp.clone().sub(fp).normalize();
    const axis = it.kind === 'pipe' ? along.clone().multiplyScalar(0.35).add(new THREE.Vector3(0, 1, 0)).normalize() : along;
    const len = it.mesh.userData.length as number;
    it.mesh.position.copy(hp).addScaledVector(along, 0.06).addScaledVector(axis, it.kind === 'pipe' ? len * 0.3 : len * 0.35);
    it.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  }
}

let bottleGeo: THREE.BufferGeometry | null = null, pipeGeo: THREE.BufferGeometry | null = null;
let bottleMat: THREE.Material | null = null, pipeMat: THREE.Material | null = null;
function makeItem(kind: ItemKind) {
  if (kind === 'bottle') {
    bottleGeo ??= new THREE.LatheGeometry([[0, 0], [0.036, 0], [0.038, 0.01], [0.038, 0.18], [0.03, 0.21], [0.014, 0.24], [0.013, 0.3], [0.015, 0.305], [0, 0.305]].map(([r, y]) => new THREE.Vector2(r, y - 0.15)), 14);
    bottleMat ??= new THREE.MeshStandardMaterial({ color: 0x2f8a3e, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85, emissive: 0x0a2a10 });
    const m = new THREE.Mesh(bottleGeo, bottleMat);
    m.userData = { length: 0.3, radius: 0.038 };
    return m;
  }
  pipeGeo ??= new THREE.CylinderGeometry(0.022, 0.022, 0.8, 10);
  pipeMat ??= new THREE.MeshStandardMaterial({ color: 0xa8acb2, roughness: 0.35, metalness: 0.85, emissive: 0x15171a }); // bare steel catches the neon
  const m = new THREE.Mesh(pipeGeo, pipeMat);
  m.userData = { length: 0.8, radius: 0.022 };
  return m;
}
