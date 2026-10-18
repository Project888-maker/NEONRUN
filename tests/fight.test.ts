// Fighting: strikes land on whoever is in front, people go down and get back up, the tough ones fight
// back and can knock the courier out, health comes back out of combat, bottles and pipes can be used.
import * as THREE from 'three';
const g = globalThis as any;
g.document ??= { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(_v: unknown) {} }), width: 0, height: 0 }) };
const { Crowd } = await import('../src/world/people');
const { Fight } = await import('../src/game/fight');
const { plinthRects } = await import('../src/world/layout');

const fail = (m: string) => { console.error('FAIL', m); process.exit(1); };
const ok = (c: unknown, m: string) => { if (!c) fail(m); };
const person = () => ({ yaw: 0, currentName: 'idle', root: { position: new THREE.Vector3(), traverse() {} }, played: [] as string[], hits: 0,
  play(n: string) { this.currentName = n; this.played.push(n); return n === 'get_up' ? 3 : n === 'fall' ? 2 : 0.8; }, place(x: number, y: number, z: number, yaw: number) { this.root.position.set(x, y, z); this.yaw = yaw; },
  update() {}, gaitRate: () => 1, has: () => true, clipDuration: () => 0.8, hitReact() { this.hits++; } });
const walkRects = plinthRects().map((r) => ({ ...r, hw: r.hw - 1.4, hd: r.hd - 1.4 }));
const crowd = new Crowd({}, { walkRects } as any, 0) as any;
const R = 40, home = new THREE.Vector3(walkRects[R].x + walkRects[R].hw, 0, walkRects[R].z);
const hero: any = { person: person(), pos: home.clone(), active: true, frozen: false, busy: 0, grounded: true, guard: 0 };
const timers: { t: number; f: () => void }[] = [];
const events: string[] = [];
const scene = new THREE.Scene();
const fight = new Fight({
  scene, crowd, hero: () => hero, walkRects,
  sound: (n) => events.push(`sound:${n}`), onAssault: (_v, ko) => events.push(ko ? 'ko' : 'assault'), say: (_v, l) => events.push(`say:${l}`),
  onKnockout: () => events.push('hero_ko'), shatter: () => events.push('shatter'), later: (t, f) => timers.push({ t, f }),
});
const step = (sec: number) => {
  for (let k = 0; k < Math.round(sec * 30); k++) {
    const dt = 1 / 30;
    hero.busy = Math.max(0, hero.busy - dt);
    for (let i = timers.length - 1; i >= 0; i--) if ((timers[i].t -= dt) <= 0) timers.splice(i, 1)[0].f();
    fight.update(dt);
    crowd.update(dt, hero.pos, null);
  }
};
const ped = (type: string, x: number, z: number) => {
  const p: any = { p: person(), type, rect: R, s: 0, dir: 1, speed: 1.3, state: 'idle', t: 99, pos: home.clone().add(new THREE.Vector3(x, 0, z)), vel: new THREE.Vector3(), id: crowd.nextId++ };
  crowd.peds.push(p);
  return p;
};
let rnd = 0.99; const realRandom = Math.random; Math.random = () => rnd;

// 1) a punk squares up, takes a beating, gives up and runs; someone already hurt goes down, gets up, runs
{
  const punk = ped('ped_punk', 0, 1.0);
  rnd = 0.1;
  let swings = 0;
  while (punk.state !== 'flee' && punk.state !== 'down' && swings < 20) { if (fight.attack(swings % 2 ? 'kick' : 'punch')) swings++; step(0.5); }
  ok(events.includes('say:taunt') && events.includes('say:beg'), 'punk did not square up and then give up');
  ok(punk.state === 'flee' || punk.state === 'down', `punk still ${punk.state} after ${swings} strikes`);
  console.log(`punk fought back, gave up after ${swings} strikes (combo: ${hero.person.played.filter((n: string) => ['punch', 'jab', 'kick'].includes(n)).join(',')})`);
  crowd.peds.length = 0;
  const v = ped('ped_vendor', 0, 1.0);
  v.hp = 15;
  hero.person.yaw = 0;
  step(1); // the last swing finishes
  ok(fight.attack('punch'), 'could not swing');
  step(0.6);
  ok(v.state === 'down' && v.ko && events.includes('ko'), `not knocked down (${v.state}, ${v.hp})`);
  step(9);
  ok(v.state === 'flee' && !v.ko && v.p.played.includes('get_up'), `did not get up and run (${v.state})`);
  console.log('knocked down, got back up, ran');
  crowd.peds.length = 0;
}
// 2) a strike at someone behind you misses
{
  const behind = ped('ped_suit', 0, -1.0);
  hero.person.yaw = 0;
  fight.attack('punch'); step(1);
  ok(behind.hp === undefined, 'hit someone behind the courier');
  crowd.peds.length = 0;
}
// 3) a worker fights back, hurts the courier; health comes back once it's over
{
  hero.person.yaw = 0;
  const w = ped('ped_worker', 0, 1.0);
  rnd = 0.1; // squares up
  fight.attack('kick'); step(0.6);
  ok(w.state === 'fight' && events.includes('say:taunt'), `worker did not square up (${w.state})`);
  rnd = 0.5;
  step(4);
  ok(fight.heroHp < 100, 'brawler never landed a blow');
  const hurt = fight.heroHp;
  console.log(`worker fought back: courier health ${hurt.toFixed(0)} after 4 s`);
  // keep fighting until the worker gives up or goes down
  for (let i = 0; i < 30 && w.state === 'fight'; i++) { fight.attack(i % 3 ? 'punch' : 'kick'); step(0.5); }
  ok(w.state !== 'fight', 'worker never stopped fighting');
  const now = fight.heroHp;
  hero.pos.add(new THREE.Vector3(60, 0, 0)); // walk away
  step(14);
  ok(fight.heroHp > now + 30 || fight.heroHp === 100, `health did not come back (${now.toFixed(0)} -> ${fight.heroHp.toFixed(0)})`);
  hero.pos.copy(home);
  crowd.peds.length = 0;
}
// 4) a knockout: the courier goes down, loses money (host), gets back up
{
  rnd = 0.1;
  const a = ped('ped_punk', 0, 1.0), b = ped('ped_rider', 0.6, 0.9);
  hero.person.yaw = 0;
  fight.attack('punch'); step(0.5);
  fight.heroHp = 10;
  rnd = 0.5;
  step(6);
  ok(events.includes('hero_ko'), `courier never knocked out (health ${fight.heroHp})`);
  ok(fight.heroHp >= 50 && hero.person.played.includes('get_up'), 'courier did not get back up');
  ok(![a, b].some((p) => p.state === 'fight'), 'still fighting after the knockout');
  crowd.peds.length = 0;
}
// 5) bottles and pipes lie around; pick one up, it breaks over someone
{
  Math.random = realRandom;
  hero.pos.copy(home);
  step(12);
  ok(fight.items.length >= 3, `only ${fight.items.length} items lying around`);
  const it = fight.items[0];
  hero.pos.copy(it.mesh.position).setY(0);
  fight.toggleItem();
  ok(fight.weapon === it, 'could not pick up');
  const kind = it.kind;
  const v = ped('ped_suit', 0, 0);
  v.pos.set(hero.pos.x + Math.sin(hero.person.yaw) * 1.0, 0, hero.pos.z + Math.cos(hero.person.yaw) * 1.0);
  Math.random = () => 0.99;
  fight.attack('punch'); step(1);
  ok((v.hp ?? 100) <= 100 - 38, `${kind} hit too weak (${v.hp})`);
  if (kind === 'bottle') ok(!fight.weapon && events.includes('shatter'), 'bottle did not break');
  else { ok(fight.weapon === it, 'pipe lost after one hit'); fight.toggleItem(); ok(!fight.weapon, 'could not drop'); }
  console.log(`picked up a ${kind}, hit for ${100 - (v.hp ?? 100)}`);
}
Math.random = realRandom;
console.log('PASS');
