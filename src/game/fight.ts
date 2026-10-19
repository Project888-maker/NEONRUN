// Street fighting on foot: a four-punch combo (left jab, right cross, left hook, right hook) and three kicks
// (front kick, roundhouse, low kick), a held block and a backstep dodge. The courier can pick up a bottle or a
// pipe lying on the sidewalk. People react: they get rocked by blows, go down, get back up and run, or (the
// tougher ones) square up, throw their own punches and kicks, and block or slip the courier's. The courier has
// health that comes back out of combat; losing it all is a knockout.
import * as THREE from 'three';
import type { Crowd, Ped } from '../world/people';
import type { HeroOnFoot } from './onfoot';

export type Strike = 'jab' | 'cross' | 'hook' | 'hook_r' | 'kick' | 'roundhouse' | 'low_kick';
type ItemKind = 'bottle' | 'pipe';
interface Item { kind: ItemKind; mesh: THREE.Mesh; held: boolean; uses: number }

/**
 * Each strike (blender/build_people.py bakes one clip per strike; the right hook is the left one mirrored):
 * `from` skips the generated wind-up, `impact` is when the fist or foot is furthest out (s, at normal speed),
 * `reach` how far in front it lands, `dmg` what it does, `head` whether it lands high (the victim's head snaps
 * back) or low (they fold over).
 */
const MOVES: Record<Strike, { from: number; impact: number; reach: number; dmg: number; head: boolean }> = {
  jab: { from: 0.5, impact: 0.9, reach: 1.3, dmg: 15, head: true },
  cross: { from: 0.45, impact: 0.833, reach: 1.4, dmg: 20, head: true },
  hook: { from: 0.4, impact: 0.7, reach: 1.15, dmg: 24, head: true },
  hook_r: { from: 0.4, impact: 0.7, reach: 1.15, dmg: 30, head: true },
  kick: { from: 0.2, impact: 0.5, reach: 1.55, dmg: 26, head: false },
  roundhouse: { from: 0.45, impact: 0.833, reach: 1.6, dmg: 34, head: true },
  low_kick: { from: 0.1, impact: 0.333, reach: 1.5, dmg: 20, head: false },
};
/** pressing punch (or kick) again within the window continues the chain; the last of each is the finisher */
const PUNCHES: Strike[] = ['jab', 'cross', 'hook', 'hook_r'];
const KICKS: Strike[] = ['kick', 'roundhouse', 'low_kick'];
/** with a bottle or pipe in the right hand, punches become right-handed swings */
const ARMED: Strike[] = ['cross', 'hook_r'];
const SPEED = 1.15; // strikes play a touch faster than generated: snappier to control
/** after the impact, this long before the next strike can start (a press during a strike is buffered) */
const RECOVER = 0.16;
const COMBO_WINDOW = 0.75;
/** between swings people simply stand their ground (the generated boxing guard hunched over with open hands) */
const GUARD = 'idle';
/** who squares up when hit (the rest run); per type, chance to fight back */
const FIGHT_BACK: Record<string, number> = { ped_punk: 0.85, ped_worker: 0.7, ped_rider: 0.6, ped_techwear: 0.55, ped_vendor: 0.3, ped_suit: 0.15, ped_student: 0.15, ped_nurse: 0.1, ped_elder: 0 };
/** how good a brawler is at covering up or slipping a blow they see coming */
const DEFENCE: Record<string, number> = { ped_punk: 0.3, ped_worker: 0.25, ped_rider: 0.35, ped_techwear: 0.4 };
/** what a brawler throws (weights) and what it does to the courier */
const BRAWL: [Strike, number, number][] = [['jab', 3, 8], ['cross', 3, 12], ['hook', 2, 13], ['kick', 1.5, 14]];
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
  /** where in the punch / kick chain the next press goes, and how long the chain stays open */
  private chain = { kind: 'punch' as 'punch' | 'kick', i: 0, t: 0 };
  /** a press made while a strike is still out: thrown as soon as it is back */
  private queued: { kind: 'punch' | 'kick'; t: number } | null = null;
  /** holding block (the forearms up in front of the face) */
  blocking = false;
  /** the dodge's no-hit window */
  private dodgeT = 0;
  /** the strike thrown last (tests, debug) */
  last: Strike | null = null;
  weapon: Item | null = null;
  items: Item[] = [];
  private spawnT = 0;
  private koT = 0;
  private hand?: THREE.Object3D;
  private fore?: THREE.Object3D;

  constructor(private h: FightHost) {}

  get knockedOut() { return this.koT > 0; }

  private ready(hero: HeroOnFoot | null): hero is HeroOnFoot {
    return !!hero && hero.active && !hero.frozen && hero.grounded && this.koT <= 0;
  }

  /** Punch or kick: each press throws the next strike of the chain (a weapon turns punches into swings). */
  attack(kind: 'punch' | 'kick') {
    const hero = this.h.hero();
    if (!this.ready(hero)) return false;
    if (hero.busy > 0) {
      // still in the last strike: remember the press and throw it the moment that one is back
      if (this.last && hero.busy < 0.6) { this.queued = { kind, t: 0.6 }; return true; }
      return false;
    }
    this.blocking = false;
    const list = kind === 'kick' ? KICKS : this.weapon ? ARMED : PUNCHES;
    const i = this.chain.kind === kind && this.chain.t > 0 ? (this.chain.i + 1) % list.length : 0;
    const strike = list[i];
    const m = MOVES[strike];
    // turn toward whoever is close in front (light aim assist, so swings land where you meant)
    const target = this.targetFor(hero, 2.6, 1.25);
    if (target) {
      hero.person.yaw = Math.atan2(target.pos.x - hero.pos.x, target.pos.z - hero.pos.z);
      this.react(target);
    }
    hero.person.play(strike, { loop: false, fade: 0.08, speed: SPEED, restart: true, from: m.from });
    const toImpact = (m.impact - m.from) / SPEED;
    hero.busy = toImpact + RECOVER;
    hero.guard = 4;
    this.chain = { kind, i, t: hero.busy + COMBO_WINDOW };
    this.last = strike;
    this.h.sound('whoosh', hero.pos, 0.5);
    this.h.later(toImpact, () => this.land(strike));
    return true;
  }

  /** Hold to keep the guard up: blows from in front do a fraction of their damage. */
  block(held: boolean) {
    const hero = this.h.hero();
    if (!held || !this.ready(hero) || (hero.busy > 0 && !this.blocking)) {
      if (this.blocking && hero) { this.blocking = false; hero.busy = 0; }
      return;
    }
    if (!this.blocking) hero.person.play('block', { fade: 0.12, speed: 1, restart: true, from: 0.3 });
    this.blocking = true;
    hero.busy = 0.12; // stands still while covering up
    hero.guard = 4;
  }

  /** A quick step back with the head down: nothing lands for a moment. */
  dodge() {
    const hero = this.h.hero();
    if (!this.ready(hero) || (hero.busy > 0 && !this.blocking)) return false;
    this.blocking = false;
    this.queued = null;
    hero.person.play('dodge', { loop: false, fade: 0.08, speed: 1.35, restart: true, from: 0.15 });
    hero.busy = 0.8;
    hero.guard = 4;
    this.dodgeT = 0.55;
    hero.slide?.set(-Math.sin(hero.person.yaw), 0, -Math.cos(hero.person.yaw)).multiplyScalar(3.2);
    this.h.sound('whoosh', hero.pos, 0.35);
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

  /** a brawler who sees the strike coming covers up or slips it (not while throwing or reeling) */
  private react(p: Ped) {
    if (p.state !== 'fight' || p.swing || (p.stagger ?? 0) > 0) return;
    const skill = DEFENCE[p.type] ?? 0.15;
    const r = Math.random();
    if (r > 1 - skill * 0.35) {
      p.defend = { kind: 'dodge', t: 0.9 };
      p.p.play('dodge', { loop: false, fade: 0.08, speed: 1.35, restart: true, from: 0.15 });
    } else if (r > 1 - skill) {
      p.defend = { kind: 'block', t: 1.0 };
      p.p.play('block', { fade: 0.1, restart: true, from: 0.3 });
    }
  }

  /** the strike reaches out: hit whoever is there */
  private land(strike: Strike) {
    const hero = this.h.hero();
    if (!hero || !hero.active) return;
    const w = this.weapon;
    const p = this.targetFor(hero, MOVES[strike].reach + (w ? 0.3 : 0), 0.95);
    if (!p) return;
    if (p.defend?.kind === 'dodge') return; // slipped it
    let dmg = MOVES[strike].dmg;
    let sound = KICKS.includes(strike) ? 'kick_hit' : 'punch_hit';
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
    if (p.defend?.kind === 'block' && !w) {
      // caught on the forearms
      p.hp = (p.hp ?? maxHp(p.type)) - dmg * 0.25;
      p.p.hitReact(0.15);
      this.h.sound(sound, p.pos.clone().setY(1.4), 0.45);
      return;
    }
    this.hit(p, dmg, hero.pos, sound, MOVES[strike].head, strike === 'hook_r' || strike === 'roundhouse');
  }

  /** someone takes a blow from the courier (`heavy`: a combo finisher, sends them reeling further) */
  hit(p: Ped, dmg: number, from: THREE.Vector3, sound = 'punch_hit', head = true, heavy = false) {
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
      p.defend = undefined;
      p.state = 'down';
      p.t = 5 + Math.random() * 2;
      p.vel.copy(away).multiplyScalar(heavy ? 2.4 : 1.6);
      p.p.play('fall', { loop: false, fade: 0.08 });
      this.h.onAssault(p, true);
      return;
    }
    p.pos.addScaledVector(away, heavy ? 0.45 : 0.22); // staggers back
    if (first) this.h.onAssault(p, false);
    if (p.state === 'fight') {
      // rocked: the head snaps back or they fold over, and the swing they were throwing is gone
      p.swing = undefined;
      p.stagger = heavy ? 0.9 : 0.55;
      p.p.play(head ? 'hit_head' : 'hit_body', { loop: false, fade: 0.06, speed: 1.3, restart: true, from: 0.1 });
      if (p.hp < 30) this.giveUp(p, from);
      return;
    }
    if (Math.random() < (FIGHT_BACK[p.type] ?? 0.2) && p.hp > 40) {
      p.state = 'fight';
      p.swingCd = 0.7 + Math.random() * 0.5;
      p.p.play(GUARD, { fade: 0.2 });
      this.h.say(p, 'taunt');
    } else this.giveUp(p, from);
  }

  private giveUp(p: Ped, from: THREE.Vector3) {
    p.swing = undefined;
    p.defend = undefined;
    p.stagger = 0;
    p.state = 'idle';
    this.h.say(p, 'beg');
    this.h.crowd.flee(p, from);
  }

  /** the courier takes a blow */
  private heroHit(dmg: number, from: THREE.Vector3, head: boolean) {
    const hero = this.h.hero();
    if (!hero || !hero.active || hero.frozen || this.koT > 0) return;
    if (this.dodgeT > 0) return; // stepped out of it
    const fx = Math.sin(hero.person.yaw), fz = Math.cos(hero.person.yaw);
    const front = (from.x - hero.pos.x) * fx + (from.z - hero.pos.z) * fz > 0;
    if (this.blocking && front) {
      this.heroHp -= dmg * 0.2;
      this.calm = 0;
      hero.person.hitReact(0.12, true);
      this.h.sound('punch_hit', hero.pos.clone().setY(1.4), 0.45);
      return;
    }
    this.heroHp -= dmg;
    this.calm = 0;
    hero.person.hitReact(Math.min(1, dmg / 25), front);
    this.h.sound('punch_hit', hero.pos.clone().setY(1.4), 1);
    this.h.sound('grunt_m', hero.pos.clone().setY(1.6), 0.7);
    if (this.heroHp <= 0) { this.knockout(hero); return; }
    if (dmg >= 10) {
      // rocked: loses the strike being thrown (and anything queued) for a moment
      this.blocking = false;
      this.queued = null;
      hero.person.play(head ? 'hit_head' : 'hit_body', { loop: false, fade: 0.06, speed: 1.4, restart: true, from: 0.1 });
      hero.busy = Math.max(hero.busy, 0.45);
    }
  }

  private knockout(hero: HeroOnFoot) {
    this.heroHp = 0;
    this.koT = 5;
    this.blocking = false;
    this.queued = null;
    hero.busy = 5;
    hero.guard = 0;
    hero.person.play('fall', { loop: false, fade: 0.1, restart: true });
    if (this.weapon) this.toggleItem();
    // everyone who was fighting walks off
    for (const p of this.h.crowd.peds) if (p.state === 'fight') { p.state = 'idle'; p.t = 2; p.swing = undefined; p.defend = undefined; p.p.play('idle', { fade: 0.4 }); }
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
    this.chain.t = Math.max(0, this.chain.t - dt);
    this.koT = Math.max(0, this.koT - dt);
    this.dodgeT = Math.max(0, this.dodgeT - dt);
    this.calm += dt;
    if (this.calm > 5 && this.heroHp < 100) this.heroHp = Math.min(100, this.heroHp + 9 * dt);
    if (this.queued && (this.queued.t -= dt) <= 0) this.queued = null;
    if (this.queued && hero && hero.busy <= 0) { const q = this.queued.kind; this.queued = null; this.attack(q); }
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

  /** a pedestrian squaring up: close in, keep guard, mix up punches and kicks every second or two */
  private brawler(p: Ped, dt: number, hero: HeroOnFoot | null) {
    const done = () => { p.state = 'idle'; p.t = 2 + Math.random() * 2; p.swing = undefined; p.defend = undefined; p.p.play('idle', { fade: 0.4 }); };
    if (!hero || this.koT > 0) { done(); return; }
    const dx = hero.pos.x - p.pos.x, dz = hero.pos.z - p.pos.z, d = Math.hypot(dx, dz);
    if (d > 14) { done(); return; }
    p.p.yaw = Math.atan2(dx, dz);
    // reeling from a blow, or covering up / slipping one
    if ((p.stagger ?? 0) > 0) {
      p.stagger! -= dt;
      if (p.stagger! <= 0) p.p.play(GUARD, { fade: 0.25 });
      return;
    }
    if (p.defend) {
      if ((p.defend.t -= dt) <= 0) { p.defend = undefined; p.p.play(GUARD, { fade: 0.2 }); }
      return;
    }
    if (p.swing) {
      const m = MOVES[p.swing.kind];
      p.swing.t += dt * SPEED;
      if (!p.swing.done && p.swing.t >= m.impact) {
        p.swing.done = true;
        this.h.sound('whoosh', p.pos, 0.4);
        if (d < m.reach + 0.15) this.heroHit(p.swing.dmg, p.pos, m.head);
        if (!p.swing) return; // that blow knocked the courier out: everyone stood down
      }
      if (p.swing.t >= m.impact + 0.45) { p.swing = undefined; p.p.play(GUARD, { fade: 0.2 }); }
      return;
    }
    if (d > 1.15) {
      const step = Math.min(d - 1.05, (d > 3 ? 3.2 : 1.6) * dt);
      p.pos.x += (dx / d) * step; p.pos.z += (dz / d) * step;
      const gait = d > 3 ? 'run' : 'walk';
      if (p.p.currentName !== gait) p.p.play(gait, { fade: 0.2, speed: p.p.gaitRate(gait, d > 3 ? 3.2 : 1.6) });
      return;
    }
    if (p.p.currentName !== GUARD) p.p.play(GUARD, { fade: 0.2 });
    p.swingCd = (p.swingCd ?? 1) - dt;
    if (p.swingCd <= 0) {
      let r = Math.random() * BRAWL.reduce((a, b) => a + b[1], 0);
      const [kind, , dmg] = BRAWL.find((b) => (r -= b[1]) <= 0) ?? BRAWL[0];
      p.p.play(kind, { loop: false, fade: 0.1, speed: SPEED, restart: true, from: MOVES[kind].from });
      p.swing = { t: MOVES[kind].from, done: false, kind, dmg };
      p.swingCd = 1.0 + Math.random() * 0.9;
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
