// Seeded persona cards: every pedestrian gets a stable, distinct personality from its id,
// with no model call. The card is what the NPC brain is told about who it is.
import { VOICE_POOLS, type Persona } from './protocol';

class Seed {
  constructor(private s: number) { this.s = (s * 2654435761) >>> 0 || 1; }
  next() { this.s ^= this.s << 13; this.s >>>= 0; this.s ^= this.s >>> 17; this.s ^= this.s << 5; this.s >>>= 0; return this.s / 4294967296; }
  pick<T>(a: readonly T[]): T { return a[Math.floor(this.next() * a.length) % a.length]; }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  /** -1..1, biased toward `bias` */
  slider(bias = 0) { return Math.max(-1, Math.min(1, bias + (this.next() + this.next() - 1))); }
}

interface Archetype {
  title: string; // short label shown in the talk panel when the name is unknown
  gender: 'f' | 'm';
  age: [number, number];
  jobs: string[];
  bias?: Partial<Persona['traits']>;
}

/** Matches the generated character models (see scripts/assets.mjs PEOPLE). */
export const ARCHETYPES: Record<string, Archetype> = {
  ped_suit: { title: 'Executive', gender: 'm', age: [42, 60], jobs: ['mid-level manager at a tower insurance firm', 'corporate lawyer', 'compliance officer for a drone logistics company', 'sales director who has just lost a big account', 'real-estate broker buying up the Backstreets'], bias: { warmth: -0.3, chatty: -0.2 } },
  ped_vendor: { title: 'Vendor', gender: 'm', age: [50, 72], jobs: ['noodle stand owner', 'dumpling seller at the night market', 'skewer grill cook', 'fruit and tea cart owner', 'soup vendor who has had the same corner for 30 years'], bias: { warmth: 0.3, chatty: 0.4 } },
  ped_punk: { title: 'Punk', gender: 'f', age: [19, 28], jobs: ['bassist in a garage band', 'tattoo apprentice', 'graffiti artist', 'bike messenger between gigs', 'bouncer at an underground club'], bias: { courage: 0.4, honesty: -0.1 } },
  ped_worker: { title: 'Dock worker', gender: 'm', age: [30, 55], jobs: ['crane operator', 'container yard loader', 'forklift driver on the night shift', 'union steward at the docks', 'customs inspector who looks the other way'], bias: { warmth: -0.1, chatty: -0.3 } },
  ped_student: { title: 'Student', gender: 'f', age: [18, 24], jobs: ['engineering student', 'nursing student working nights at a café', 'film student shooting rain footage', 'law student behind on rent', 'art student who sells prints on the strip'], bias: { nerve: 0.2, warmth: 0.2 } },
  ped_elder: { title: 'Old lady', gender: 'f', age: [68, 88], jobs: ['retired schoolteacher', 'widow who runs the laundry downstairs', 'former singer at a long-gone jazz bar', 'grandmother walking home from mahjong', 'retired seamstress who knows every family on the street'], bias: { warmth: 0.2, chatty: 0.5, courage: 0.2 } },
  ped_techwear: { title: 'Netrunner', gender: 'm', age: [21, 33], jobs: ['freelance security tester', 'AR game designer', 'implant technician', 'crypto trader', 'drone pilot for a news feed'], bias: { warmth: -0.2, honesty: -0.2 } },
  ped_nurse: { title: 'Nurse', gender: 'f', age: [38, 52], jobs: ['ER nurse at the district clinic', 'night-shift ward nurse', 'paramedic between calls', 'clinic nurse who also patches up street racers off the books'], bias: { warmth: 0.2, nerve: -0.2, courage: 0.3 } },
  ped_rider: { title: 'Rider', gender: 'm', age: [22, 38], jobs: ['food delivery rider', 'rival courier for a bigger company', 'motorbike taxi rider', 'parcel rider saving for his own shop'], bias: { chatty: 0.2, courage: 0.2 } },
};

const NAMES = {
  f: ['Mei', 'Aiko', 'Priya', 'Nadia', 'Lucia', 'Rosa', 'Yuna', 'Amara', 'Ines', 'Hana', 'Talia', 'Zofia', 'Keiko', 'Imani', 'Lena', 'Mira', 'Soo-ah', 'Farah', 'Ada', 'Juno', 'Noor', 'Elif', 'Bea', 'Kalinda'],
  m: ['Kenji', 'Mateo', 'Ravi', 'Dmitri', 'Tomas', 'Wei', 'Kwame', 'Omar', 'Jonah', 'Hiro', 'Luca', 'Arjun', 'Bao', 'Felix', 'Idris', 'Marek', 'Sung-min', 'Diego', 'Emeka', 'Yusuf', 'Anton', 'Rafe', 'Chen', 'Oskar'],
};
const SURNAMES = ['Okafor', 'Tanaka', 'Novak', 'Reyes', 'Lindqvist', 'Haddad', 'Kowalski', 'Mensah', 'Ishikawa', 'Varga', 'Delgado', 'Nakamura', 'Petrov', 'Osei', 'Moreau', 'Kaur', 'Ferreira', 'Kim', 'Abara', 'Sato', 'Rahman', 'Costa'];

const MOODS = ['tired after a long shift', 'in a great mood, just got paid', 'irritable, soaked by the rain', 'anxious about money', 'bored and looking for distraction', 'lonely tonight', 'excited about something they will not shut up about', 'grieving quietly', 'suspicious of everyone tonight', 'a little drunk and cheerful', 'in a hurry', 'calm and content'];
const QUIRKS = ['hums old songs under their breath', 'calls everyone by a nickname', 'answers questions with questions', 'complains about the monorail constantly', 'collects gossip and trades it', 'is superstitious about rain', 'never finishes a sentence when nervous', 'quotes their grandmother', 'checks their phone every few seconds', 'speaks in very short sentences', 'loves bad puns', 'is obsessed with street racing results', 'distrusts anything made in the towers', 'always tries to sell you something'];
const GOALS = ['pay off a debt to the wrong people', 'get home before the last monorail', 'find their missing cat', 'get a job in the towers', 'save their family shop from being bought out', 'win the street race on Friday', 'find out who keeps tagging their wall', 'get a cheap ride across the district', 'meet someone nice', 'make enough for a ticket out of the city', 'keep their kid out of trouble', 'buy a real, non-printed guitar'];
const FEARS = ['the police', 'the security drones', 'losing their job', 'the gangs at the docks', 'being evicted', 'getting old alone', 'crashing on wet roads', 'the towers watching everything', 'debt collectors', 'hospitals'];
const SPEECH = ['slangy and fast', 'polite and formal', 'rambling, goes off on tangents', 'dry and sarcastic', 'warm and motherly', 'gruff, few words', 'nervous, apologetic', 'loud and theatrical', 'precise and a bit condescending', 'cheerful and full of exclamations'];

const DISTRICT_NAMES: Record<string, string> = { neon: 'Neon District', backstreets: 'Backstreets', downtown: 'Downtown Towers', docks: 'Industrial Docks' };

/** A stable persona for a pedestrian: same id + type always gives the same person. */
export function makePersona(id: number, type: string, district: string): Persona {
  const a = ARCHETYPES[type] ?? ARCHETYPES.ped_rider;
  const r = new Seed(id * 7919 + type.length * 104729 + 17);
  const b = a.bias ?? {};
  const traits = { warmth: r.slider(b.warmth), nerve: r.slider(b.nerve), honesty: r.slider(b.honesty), chatty: r.slider(b.chatty), courage: r.slider(b.courage) };
  const first = r.pick(NAMES[a.gender]);
  return {
    id: `${type}:${id}`,
    name: a.age[0] > 60 && r.next() < 0.5 ? `${a.gender === 'f' ? 'Mrs.' : 'Mr.'} ${r.pick(SURNAMES)}` : `${first} ${r.pick(SURNAMES)}`,
    age: Math.round(r.range(a.age[0], a.age[1])),
    job: r.pick(a.jobs),
    district: DISTRICT_NAMES[district] ?? district,
    traits,
    mood: r.pick(MOODS),
    quirk: r.pick(QUIRKS),
    goal: r.pick(GOALS),
    fear: r.pick(FEARS),
    speech: r.pick(SPEECH),
  };
}

/**
 * How this person sounds: an ElevenLabs stock voice picked by gender, age and id (so two people of
 * the same type usually differ), a speaking speed from temperament, and pitch/rate for the
 * device-voice fallback.
 */
export function voiceFor(p: Persona, type: string) {
  const a = ARCHETYPES[type] ?? ARCHETYPES.ped_rider;
  const band = p.age < 30 ? 'young' : p.age < 60 ? 'mid' : 'old';
  const pool = VOICE_POOLS[a.gender][band];
  const seed = [...p.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const age = (p.age - 18) / 70; // 0 young .. 1 old
  return {
    name: pool[seed % pool.length] as string,
    gender: a.gender,
    speed: Math.max(0.85, Math.min(1.15, 1.0 + p.traits.chatty * 0.07 + p.traits.nerve * 0.05 - age * 0.08)),
    pitch: Math.max(0.6, Math.min(1.5, (a.gender === 'f' ? 1.15 : 0.9) - age * 0.25 + p.traits.nerve * 0.08)),
    rate: Math.max(0.8, Math.min(1.25, 1.0 + p.traits.chatty * 0.12 + p.traits.nerve * 0.06 - age * 0.12)),
  };
}
