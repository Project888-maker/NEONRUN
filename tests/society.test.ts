// Phase B: places, regulars, memory, reputation, street jobs and street remarks (no browser, no model).
import * as THREE from 'three';
import { GRID, PITCH, ROAD_W, blockCenter, districtOfBlock, type DistrictId } from '../src/world/layout';
import { PLACES, REGULARS, locatePlaces, randomJob, regularId } from '../src/npc/regulars';
import { Society } from '../src/npc/society';
import { Barks, BARKS } from '../src/npc/barks';
import { normalizeReply, buildUserMessage, sanitizeRequest } from '../src/npc/protocol';
import type { Save } from '../src/game/progress';

const g = globalThis as any;
g.localStorage ??= { getItem: () => null, setItem() {} };
const fail = (m: string) => { console.error('FAIL', m); process.exit(1); };
const ok = (c: unknown, m: string) => { if (!c) fail(m); };

// synthetic shopfront spots on every block edge (the real ones come from the city build)
const spots: { x: number; z: number; district: DistrictId; nx: number; nz: number }[] = [];
const half = (PITCH - ROAD_W) / 2;
for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
  spots.push({ x: blockCenter(i) + nx * (half + 2), z: blockCenter(j) + nz * (half + 2), district: districtOfBlock(i, j), nx, nz });
}

// places
const places = locatePlaces(spots);
ok(places.size === PLACES.length, `placed ${places.size}/${PLACES.length}`);
ok(new Set([...places.values()].map((p) => p.spot)).size === places.size, 'two places share a shopfront');
for (const p of places.values()) ok(p.spot.district === p.place.district, `${p.place.id} in the wrong district`);
for (const r of REGULARS) { ok(places.has(r.home), `${r.key} has no home`); for (const j of r.jobs) ok(places.has(j.place) && j.place !== r.home, `${r.key} job place`); }
console.log(`places: ${places.size} named places, each in its own district; ${REGULARS.length} regulars with ${REGULARS.reduce((a, r) => a + r.jobs.length, 0)} jobs`);

// random jobs: about one person in eight, always somewhere in another district
let withJob = 0;
for (let id = 1; id <= 2000; id++) { const j = randomJob(id, 'neon'); if (j) { withJob++; ok(PLACES.find((p) => p.id === j.place)!.district !== 'neon', 'random job in own district'); } }
ok(withJob > 160 && withJob < 360, `random jobs ${withJob}/2000`);
console.log(`random jobs: ${withJob} of 2000 people have one`);

// protocol: job offers and relationship survive normalising; the hook reaches the prompt
const n = normalizeReply({ line: 'Take this to the hotel?', emotion: 'curious', gesture: 'talk', action: 'offer_job', replies: [], remember: '', relationship: 'warmer' })!;
ok(n.action === 'offer_job' && n.relationship === 'warmer', 'offer_job / relationship');
ok(normalizeReply({ line: 'x', relationship: 'besties' })!.relationship === 'same', 'bad relationship');
const req = sanitizeRequest({ persona: { name: 'A', hook: 'take a box to the pier; you pay about 300 credits' }, facts: [], history: [], say: null, notes: [] })!;
ok(buildUserMessage(req).includes('A job you could give a courier you trust: take a box'), 'hook in prompt');
ok(buildUserMessage({ ...req, persona: { ...req.persona, hook: null } }).includes('no job to give'), 'no-hook line');

// society with stand-ins for the game
const save: Save = { credits: 100, deliveries: 0, bestStreak: 0, unlocked: ['neon', 'backstreets', 'downtown', 'docks'], upgrades: { speed: 0, grip: 0, boost: 0 }, paint: '', underglow: '', livery: null, car: 'hero', ownedCars: [], story: { done: [], best: {} }, settings: { quality: 'low', master: 1, music: 1, sfx: 1, cam: 'chase' }, npc: {}, rep: { neon: 0, backstreets: 0, downtown: 0, docks: 0 } };
const fixed: any[] = [];
let started: any = null, suspended = 0, busy = false;
const player = new THREE.Vector3();
const toasts: string[] = [];
const soc = new Society({
  crowd: { addFixed: (type: string, pos: THREE.Vector3, yaw: number, key: string) => { const p = { id: 1000 + fixed.length, type, pos: pos.clone(), key, state: 'idle', t: 1e9, p: {} }; fixed.push(p); return p; }, byKey: (k: string) => fixed.find((p) => p.key === k) ?? null } as any,
  campaign: { get active() { return started; }, start: (d: any) => { started = d; } } as any,
  save, hud: { toast: (t: string) => toasts.push(t), setCredits() {} } as any, audio: { play() {} } as any, spots,
  playerPos: () => player, busy: () => busy, suspendDeliveries: (on) => { suspended += on ? 1 : -1; },
  counter: (id) => places.get(id)!.stand.clone().add(new THREE.Vector3(0, 0, -5)), inside: () => null,
});
const ish = REGULARS.find((r) => r.key === 'ishikawa')!;
player.copy(places.get(ish.home)!.stand);
// regulars work inside their place, behind the counter
const t: any = { id: 1, type: ish.type, pos: places.get(ish.home)!.stand.clone(), state: 'talk', t: 1, key: regularId(ish), inside: ish.home, role: 'clerk', roomType: 'food', p: {} };
const per = soc.persona(t);
ok(per.name === 'Mr. Ishikawa' && per.hook?.includes('broth bones') && per.hook.includes('credits'), `regular persona hook: ${per.hook}`);
ok(soc.facts(per, t, []).some((f) => f.includes('never met')), 'stranger fact');
ok(soc.facts(per, t, []).some((f) => f.includes('behind the counter inside')), 'regular is at work inside');
// a customer in a shop knows they don't work there; a clerk has a delivery for the shop
const cust: any = { id: 801, type: 'ped_student', pos: new THREE.Vector3(5000, 0, 5000), state: 'talk', t: 1, inside: 'arcade', role: 'customer', roomType: 'shop', p: {} };
ok(soc.facts(soc.persona(cust), cust, []).some((f) => f.includes('customer inside')) && !soc.persona(cust).hook, 'customer facts / no job');
const clerk: any = { id: 802, type: 'ped_punk', pos: new THREE.Vector3(5000, 0, 5000), state: 'talk', t: 1, inside: 'arcade', role: 'clerk', roomType: 'shop', p: {} };
const cp = soc.persona(clerk);
ok(cp.job.includes('Pixel Palace') && cp.hook?.startsWith('take '), `clerk persona: ${cp.job} / ${cp.hook}`);
// memory persists in the save
soc.remember(per, { history: [{ who: 'courier', text: 'Evening!' }, { who: 'npc', text: 'Hungry, kid?' }], notes: ['polite courier'], rel: 1 });
ok(save.npc[per.id].met === 1 && save.npc[per.id].notes[0] === 'polite courier' && soc.recall(per).history.length === 2, 'regular memory not saved');
// busy with a parcel: no job; free: a job
busy = true; ok(!soc.job(t, per), 'job offered while carrying a parcel'); busy = false;
const job = soc.job(t, per)!;
ok(job && job.pay >= 150 && job.pay <= 900, `job pay ${job?.pay}`);
soc.acceptJob(t, per);
ok(started?.street && soc.active && suspended === 1, 'street job not started');
ok(!soc.job(t, per) && !soc.persona(t).hook, 'second job offered while one is running');
const steps = started.build({ goto: (at: THREE.Vector3, prompt: string) => ({ at, prompt }), legTime: () => 60, sfx() {} }).steps;
ok(steps.length === 4 && steps[0].prompt.includes('Pick up') && steps[1].prompt().includes('Go inside') && steps[2].prompt.includes('Bring') && steps[3].marker === 'ring', 'fetch job steps: door, counter, door, counter');
// finish: paid, reputation up, remembered, next job different
const before = save.credits;
started.street.onFinish(true, undefined, 20);
started = null;
ok(save.credits === before + job.pay + 80 && suspended === 0, 'job pay');
ok(save.rep.neon >= 6 && save.npc[per.id].jobsDone === 1 && save.npc[per.id].rel === 2, 'reputation / memory after job');
ok(soc.facts(soc.persona(t), t, []).some((f) => f.includes('done 1 job')), 'job remembered in facts');
ok(soc.persona(t).hook?.includes('noodle boxes'), 'next job not offered');
console.log(`job: "${job.title}" for ${job.pay} CR -> paid ${job.pay + 80}, neon rep ${save.rep.neon}, Ishikawa remembers ${save.npc[per.id].jobsDone} job, relationship ${save.npc[per.id].rel}`);
// a regular you burned won't give you work; locked districts are never job destinations
save.npc[per.id].rel = -3;
ok(!soc.job(t, soc.persona(t)), 'job from a regular who despises you');
save.npc[per.id].rel = 0;
save.unlocked = ['backstreets']; // his next job goes to the clinic in the Neon District
ok(!soc.job(t, soc.persona(t)), 'job into a locked district');
save.unlocked = ['neon', 'backstreets', 'downtown', 'docks'];
// reputation events
soc.repEvent('carjack', places.get('arcade')!.stand);
soc.repEvent('hit', places.get('arcade')!.stand);
ok(save.rep.neon === 6 - 6 - 8, `rep after crimes ${save.rep.neon}`); // +6 for the job, -6 carjack, -8 hit
console.log(`reputation: neon ${save.rep.neon} after a carjack and a hit`);

// street remarks: nobody repeats a line until they've used them all; each person waits between remarks
{
  const said: { who: string; text: string }[] = [];
  const ped = { id: 7, type: 'ped_vendor', pos: new THREE.Vector3(1, 0, 0), state: 'walk' };
  const b = new Barks({
    crowdPeds: () => [ped], speaker: () => ({ name: 'Vendor', voice: 'Bill', speed: 1, key: 'p7' }),
    voice: async () => null, play() {}, subtitle: (who, text) => said.push({ who, text }), voiceOn: () => false, quiet: () => false,
  });
  const n = BARKS.ped_vendor.near_miss.length;
  for (let i = 0; i < n; i++) { (b as any).nextAt.clear(); (b as any).globalAt = 0; b.event('near_miss', ped.pos, 5); }
  ok(new Set(said.map((s) => s.text)).size === n, `repeated a remark: ${said.map((s) => s.text).join(' | ')}`);
  said.length = 0;
  b.event('near_miss', ped.pos, 5); b.event('near_miss', ped.pos, 5);
  ok(said.length === 0, 'same person remarked again without a pause');
  let total = 0;
  for (const k of Object.keys(BARKS)) for (const ev of Object.keys(BARKS[k])) total += (BARKS[k] as any)[ev].length;
  console.log(`remarks: ${total} written lines for ${Object.keys(BARKS).length} kinds of people; no repeats per person, ~25-45 s between remarks`);
}
console.log('PASS');
