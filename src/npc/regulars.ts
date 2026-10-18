// Named places around the city, the regulars who live at them, and the street jobs people can give.
// The game owns what a job is (where, what, pay); the NPC brain only decides when someone offers it.
import * as THREE from 'three';
import type { Spot } from '../world/city';
import { GRID, blockCenter, districtOfBlock, type DistrictId } from '../world/layout';
import type { Persona } from './protocol';

export interface Place { id: string; name: string; district: DistrictId }

export const PLACES: Place[] = [
  { id: 'noodle_row', name: 'Noodle Row on the strip', district: 'neon' },
  { id: 'arcade', name: 'the Pixel Palace arcade', district: 'neon' },
  { id: 'clinic', name: 'the all-night clinic', district: 'neon' },
  { id: 'night_market', name: 'the night market', district: 'backstreets' },
  { id: 'laundromat', name: 'Suds laundromat', district: 'backstreets' },
  { id: 'tattoo', name: 'the Ink & Iron tattoo parlor', district: 'backstreets' },
  { id: 'tower', name: 'the Meridian Tower lobby', district: 'downtown' },
  { id: 'hotel', name: 'the Grand Lumen hotel', district: 'downtown' },
  { id: 'courthouse', name: 'the old courthouse', district: 'downtown' },
  { id: 'pier9', name: 'the Pier 9 container yard', district: 'docks' },
  { id: 'union_hall', name: "the dockworkers' union hall", district: 'docks' },
  { id: 'fish_market', name: 'the fish market', district: 'docks' },
];

export interface PlaceSpot { place: Place; spot: Spot; /** on the sidewalk in front of the shopfront */ stand: THREE.Vector3; /** at the curb, where a car stops */ curb: THREE.Vector3 }

/** Where each place is: spread over its district's blocks (deterministic), at the nearest shopfront. */
export function locatePlaces(spots: Spot[]): Map<string, PlaceSpot> {
  const out = new Map<string, PlaceSpot>();
  const byDistrict = new Map<DistrictId, { x: number; z: number }[]>();
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
    const d = districtOfBlock(i, j);
    (byDistrict.get(d) ?? byDistrict.set(d, []).get(d)!).push({ x: blockCenter(i), z: blockCenter(j) });
  }
  const used = new Set<Spot>();
  for (const d of byDistrict.keys()) {
    const blocks = byDistrict.get(d)!;
    const places = PLACES.filter((p) => p.district === d);
    places.forEach((place, k) => {
      const b = blocks[Math.floor(((k + 0.5) / places.length) * blocks.length)];
      let best: Spot | null = null, bd = Infinity;
      for (const s of spots) {
        if (s.district !== d || used.has(s)) continue;
        const q = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
        if (q < bd) { bd = q; best = s; }
      }
      if (!best) return;
      used.add(best);
      const stand = new THREE.Vector3(best.x - best.nx * 3, 0.15, best.z - best.nz * 3);
      const curb = new THREE.Vector3(best.x + best.nx * 1.5, 0, best.z + best.nz * 1.5);
      out.set(place.id, { place, spot: best, stand, curb });
    });
  }
  return out;
}

export type JobKind = 'deliver' | 'fetch';
export interface Job { kind: JobKind; item: string; place: string; /** set for regulars: their own spot (fetch jobs come back here) */ from?: string }

export interface Regular {
  key: string;
  type: string; // character model
  home: string; // place id
  persona: Omit<Persona, 'id' | 'district' | 'hook'>;
  jobs: Job[];
}

/** People who are always at their spot, remember the courier between sessions and have work to give. */
export const REGULARS: Regular[] = [
  {
    key: 'ishikawa', type: 'ped_vendor', home: 'noodle_row',
    persona: { name: 'Mr. Ishikawa', age: 64, job: 'noodle stand owner on Noodle Row for 30 years', traits: { warmth: 0.6, nerve: -0.3, honesty: 0.8, chatty: 0.5, courage: 0.2 }, mood: 'busy, the dinner rush is coming', quirk: 'calls everyone "kid" and judges people by how they eat', goal: 'keep the stand going one more year before his knees give out', fear: 'the towers buying up the strip', speech: 'warm, gruff, quick, food metaphors' },
    jobs: [{ kind: 'fetch', item: 'a crate of fresh broth bones', place: 'fish_market' }, { kind: 'deliver', item: 'a stack of hot noodle boxes', place: 'clinic' }],
  },
  {
    key: 'juno', type: 'ped_punk', home: 'arcade',
    persona: { name: 'Juno Varga', age: 23, job: 'arcade attendant who quietly runs the street-race betting book', traits: { warmth: 0.1, nerve: 0.2, honesty: -0.4, chatty: 0.4, courage: 0.7 }, mood: 'restless, waiting for race results', quirk: 'rates everything out of ten', goal: 'save enough to buy her own garage', fear: 'getting caught by the police with the betting book', speech: 'fast, sarcastic, street slang' },
    jobs: [{ kind: 'deliver', item: 'a sealed envelope of race bets', place: 'hotel' }, { kind: 'fetch', item: 'a bag of payout chips', place: 'tattoo' }],
  },
  {
    key: 'okafor', type: 'ped_elder', home: 'laundromat',
    persona: { name: 'Mrs. Okafor', age: 79, job: 'runs Suds laundromat and knows every family on the street', traits: { warmth: 0.8, nerve: -0.2, honesty: 0.9, chatty: 0.8, courage: 0.4 }, mood: 'cheerful, a bit tired', quirk: 'tells you who your mother would be ashamed of', goal: "see her grandson finish his nursing exams", fear: 'the laundromat being bought out for a parking tower', speech: 'warm and motherly, scolds affectionately' },
    jobs: [{ kind: 'deliver', item: "her grandson's forgotten lunch box", place: 'clinic' }, { kind: 'fetch', item: 'a bundle of clean hotel linen she is owed money for', place: 'hotel' }],
  },
  {
    key: 'hiro', type: 'ped_techwear', home: 'tattoo',
    persona: { name: 'Hiro Delgado', age: 27, job: 'implant technician working out of the back of the tattoo parlor', traits: { warmth: -0.1, nerve: 0.3, honesty: -0.2, chatty: -0.2, courage: 0.1 }, mood: 'jittery, too much coffee', quirk: 'speaks about people like they are hardware', goal: 'open a legal clinic of his own', fear: 'tower security tracing his parts', speech: 'precise, clipped, tech jargon' },
    jobs: [{ kind: 'fetch', item: 'a crate of spare optic chips', place: 'pier9' }, { kind: 'deliver', item: 'a calibrated arm implant in a cold case', place: 'courthouse' }],
  },
  {
    key: 'lindqvist', type: 'ped_suit', home: 'tower',
    persona: { name: 'Anton Lindqvist', age: 52, job: 'compliance officer at Meridian Tower', traits: { warmth: -0.3, nerve: 0.5, honesty: 0.3, chatty: -0.3, courage: -0.4 }, mood: 'anxious, keeps checking over his shoulder', quirk: 'over-explains everything in legal terms', goal: 'leak proof of what his company is doing without getting caught', fear: 'his own employer', speech: 'polite, formal, nervous' },
    jobs: [{ kind: 'deliver', item: 'a sealed hard drive', place: 'courthouse' }, { kind: 'deliver', item: 'an unmarked envelope for a journalist', place: 'night_market' }],
  },
  {
    key: 'rosa', type: 'ped_nurse', home: 'hotel',
    persona: { name: 'Rosa Kowalski', age: 46, job: 'house medic at the Grand Lumen hotel', traits: { warmth: 0.4, nerve: -0.5, honesty: 0.6, chatty: 0.1, courage: 0.6 }, mood: 'calm, a long night ahead', quirk: 'diagnoses strangers at a glance', goal: 'get medicine to people the clinics turn away', fear: 'running out of supplies', speech: 'dry humour, direct, kind underneath' },
    jobs: [{ kind: 'fetch', item: 'a cooler of insulin', place: 'clinic' }, { kind: 'deliver', item: 'a first-aid kit for the dock crews', place: 'union_hall' }],
  },
  {
    key: 'kwame', type: 'ped_worker', home: 'union_hall',
    persona: { name: 'Kwame Mensah', age: 48, job: "union steward at the docks", traits: { warmth: 0.3, nerve: -0.3, honesty: 0.7, chatty: 0.3, courage: 0.8 }, mood: 'fired up, a strike vote is coming', quirk: 'turns every conversation to workers\' rights', goal: 'win the strike vote', fear: 'the company replacing the crews with drones', speech: 'booming, rallying, plain words' },
    jobs: [{ kind: 'deliver', item: 'a box of strike-vote flyers', place: 'night_market' }, { kind: 'fetch', item: 'the printed ballots', place: 'arcade' }],
  },
  {
    key: 'diego', type: 'ped_rider', home: 'pier9',
    persona: { name: 'Diego Ferreira', age: 29, job: 'delivery rider whose bike just died', traits: { warmth: 0.5, nerve: 0.4, honesty: 0.4, chatty: 0.6, courage: 0.0 }, mood: 'stressed, an order is going cold', quirk: 'talks to his dead bike like a person', goal: 'keep his rating above four stars', fear: 'losing his rider account', speech: 'friendly, rambling, apologetic' },
    jobs: [{ kind: 'deliver', item: 'a takeaway order that is already late', place: 'tower' }, { kind: 'deliver', item: 'a spare battery for another rider', place: 'noodle_row' }],
  },
];

export const regularId = (r: Regular) => `regular:${r.key}`;

/** A job sentence for the persona card. */
export function hookText(job: Job, places: Map<string, PlaceSpot>, pay: number, giverHome?: string) {
  const p = places.get(job.place)?.place;
  if (!p) return null;
  const where = `${p.name} (${p.district === 'neon' ? 'Neon District' : p.district === 'backstreets' ? 'Backstreets' : p.district === 'downtown' ? 'Downtown' : 'the Docks'})`;
  return job.kind === 'deliver'
    ? `take ${job.item} to ${where}, quickly; you pay about ${pay} credits`
    : `pick up ${job.item} at ${where} and bring it back to you${giverHome ? ' here' : ''}; you pay about ${pay} credits`;
}

/** Pay for a job: base plus driving distance (round trip for fetches), in line with free-ride deliveries. */
export function jobPay(distance: number, kind: JobKind) {
  return Math.round(Math.min(900, 150 + distance * (kind === 'fetch' ? 0.3 : 0.28)) / 10) * 10;
}

/** Some ordinary pedestrians have a small job too (about one in eight), deterministic per person. */
export function randomJob(id: number, district: DistrictId): Job | null {
  const h = ((id * 2654435761) >>> 0) / 4294967296;
  if (h > 0.13) return null;
  const items = ['a forgotten phone', 'a birthday present', 'a bag of groceries', 'a spare key', 'a box of vinyl records', 'a sealed letter', 'a repaired watch', 'a bouquet of synthetic flowers'];
  const others = PLACES.filter((p) => p.district !== district);
  const place = others[Math.floor(h * 1000) % others.length];
  return { kind: Math.floor(h * 777) % 3 === 0 ? 'fetch' : 'deliver', item: items[Math.floor(h * 5000) % items.length], place: place.id };
}

/** A shop's own delivery: the person behind the counter needs a package taken somewhere (deterministic per person). */
export function shopJob(id: number, from: string): Job {
  const h = ((id * 2246822519) >>> 0) / 4294967296;
  const items = ['a sealed parcel', 'a box of spare parts', 'a padded envelope', 'a cooler bag of orders', 'a stack of printed menus', 'a case of samples', 'a repaired radio', 'a bag of laundry'];
  const others = PLACES.filter((p) => p.id !== from);
  return { kind: 'deliver', item: items[Math.floor(h * 997) % items.length], place: others[Math.floor(h * 7919) % others.length].id };
}
