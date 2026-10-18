// The people layer of the city: regulars at their spots, what everyone remembers about the courier,
// district reputation, and the street jobs people hand out (run by the mission system in street mode).
import * as THREE from 'three';
import type { Crowd } from '../world/people';
import type { Campaign, MissionDef } from '../game/campaign';
import type { Hud } from '../game/hud';
import type { AudioSys } from '../audio/audio';
import { DISTRICTS, districtAt, type DistrictId } from '../world/layout';
import type { Spot } from '../world/city';
import { addRep, newMemory, repLabel, writeSave, type Save } from '../game/progress';
import { makePersona } from './persona';
import type { Persona } from './protocol';
import type { Memory, Talker } from './conversation';
import { REGULARS, PLACES, locatePlaces, regularId, hookText, jobPay, randomJob, shopJob, type Job, type PlaceSpot, type Regular } from './regulars';

export interface SocietyHost {
  crowd: Crowd; campaign: Campaign; save: Save; hud: Hud; audio: AudioSys; spots: Spot[];
  playerPos(): THREE.Vector3;
  /** true while the courier is carrying a free-ride parcel (no side jobs then) */
  busy(): boolean;
  /** pause / resume the free-ride delivery job while a street job runs */
  suspendDeliveries(on: boolean): void;
  /** the counter inside a place (building its room if needed) */
  counter(placeId: string): THREE.Vector3;
  /** the place the courier is inside right now, if any */
  inside(): string | null;
}

const CLERK_JOB: Record<string, string> = {
  food: 'cook behind the counter', market: 'stallholder', shop: 'works the counter', clinic: 'night receptionist', lobby: 'front desk clerk', depot: 'shift dispatcher',
};

interface Active { giverId: string; giverName: string; giverDistrict: DistrictId; job: Job; pay: number; regular: Regular | null; def: MissionDef }

const relLabel = (r: number) => r >= 4 ? 'you trust them completely' : r >= 2 ? 'you like them' : r >= 1 ? 'you are warming to them' : r <= -3 ? 'you despise them' : r <= -1 ? 'you are wary of them' : 'neutral';

export class Society {
  places: Map<string, PlaceSpot>;
  active: Active | null = null;
  private personas = new Map<number, Persona>();
  private session = new Map<string, Memory>();
  private spawnT = 0;

  constructor(private h: SocietyHost) {
    this.places = locatePlaces(h.spots);
  }

  regularOf(t: Talker) { return t.key ? REGULARS.find((r) => regularId(r) === t.key) ?? null : null; }

  /** Regulars work inside their places now (see Interiors); nothing to keep alive out on the street. */
  update(_dt: number) { void this.spawnT; }

  /** Spots of regulars who have work for the courier right now (for the minimap). */
  jobMarkers(): THREE.Vector3[] {
    if (this.active || this.h.campaign.active || this.h.busy()) return [];
    const out: THREE.Vector3[] = [];
    for (const r of REGULARS) {
      const ps = this.places.get(r.home);
      if (!ps) continue;
      const m = this.h.save.npc[regularId(r)];
      if (m && m.rel <= -3) continue;
      const job = r.jobs[(m?.jobsDone ?? 0) % r.jobs.length];
      const dest = this.places.get(job.place);
      if (dest && this.h.save.unlocked.includes(dest.place.district) && this.h.save.unlocked.includes(ps.place.district)) out.push(ps.stand);
    }
    return out;
  }

  // ---------------------------------------------------------------- who people are
  persona(t: Talker): Persona {
    const r = this.regularOf(t);
    if (r) {
      const ps = this.places.get(r.home)!;
      return { ...r.persona, id: regularId(r), district: DISTRICTS[ps.place.district].name, hook: this.hookFor(t, r) };
    }
    let p = this.personas.get(t.id);
    if (!p) {
      const home = t.inside ? this.places.get(t.inside) : null;
      p = makePersona(t.id, t.type, home ? home.place.district : districtAt(t.pos.x, t.pos.z));
      // the person behind a counter works there
      if (home && t.role === 'clerk') p = { ...p, job: `${CLERK_JOB[t.roomType ?? 'shop'] ?? 'works'} at ${home.place.name}` };
      this.personas.set(t.id, p);
    }
    if (this.personas.size > 300) this.personas.delete(this.personas.keys().next().value!);
    return { ...p, hook: this.hookFor(t, null) };
  }

  /** The job this person could give right now (one at a time, only to unlocked districts). */
  private jobOf(t: Talker, r: Regular | null): { job: Job; pay: number; from: THREE.Vector3 } | null {
    if (this.active || this.h.campaign.active || this.h.busy()) return null;
    let job: Job | null;
    let from = t.pos;
    if (r) {
      const m = this.h.save.npc[regularId(r)] ?? newMemory();
      if (m.rel <= -3) return null; // they won't trust you with anything
      job = r.jobs[m.jobsDone % r.jobs.length];
      from = this.places.get(r.home)!.curb;
    } else if (t.inside && t.role === 'clerk') {
      job = shopJob(t.id, t.inside);
      from = this.places.get(t.inside)!.curb;
    } else if (t.inside) job = null;
    else job = randomJob(t.id, districtAt(t.pos.x, t.pos.z));
    if (!job) return null;
    const dest = this.places.get(job.place);
    if (!dest || !this.h.save.unlocked.includes(dest.place.district)) return null;
    const dist = from.distanceTo(dest.curb) * (job.kind === 'fetch' ? 2 : 1);
    return { job, pay: jobPay(dist, job.kind), from };
  }
  private hookFor(t: Talker, r: Regular | null) {
    const j = this.jobOf(t, r);
    return j ? hookText(j.job, this.places, j.pay, r?.home) : null;
  }

  // ---------------------------------------------------------------- memory
  recall(p: Persona): Memory {
    if (p.id.startsWith('regular:')) {
      const m = this.h.save.npc[p.id] ?? newMemory();
      return { history: m.last.map((x) => ({ ...x })), notes: [...m.notes], rel: m.rel };
    }
    return this.session.get(p.id) ?? { history: [], notes: [], rel: 0 };
  }
  remember(p: Persona, m: Memory) {
    if (p.id.startsWith('regular:')) {
      const s = this.h.save;
      const cur = s.npc[p.id] ?? newMemory();
      if (cur.last.length === 0 || m.history.length <= 2) cur.met++;
      cur.last = m.history.slice(-6);
      cur.notes = m.notes.slice(-6);
      cur.rel = m.rel;
      s.npc[p.id] = cur;
      writeSave(s);
      return;
    }
    this.session.set(p.id, { history: m.history.slice(-16), notes: m.notes.slice(-6), rel: m.rel });
    if (this.session.size > 200) this.session.delete(this.session.keys().next().value!);
  }
  private note(id: string, text: string, rel: number, done: boolean) {
    if (id.startsWith('regular:')) {
      const s = this.h.save;
      const m = s.npc[id] ?? newMemory();
      m.notes.push(text); if (m.notes.length > 6) m.notes.shift();
      m.rel = Math.max(-5, Math.min(5, m.rel + rel));
      if (done) m.jobsDone++; else m.jobsFailed++;
      s.npc[id] = m;
    } else {
      const m = this.session.get(id) ?? { history: [], notes: [], rel: 0 };
      m.notes.push(text); m.rel += rel;
      this.session.set(id, m);
    }
  }

  /** What this person knows about the courier beyond the moment itself. */
  facts(p: Persona, t: Talker | null, base: string[]): string[] {
    const pp = this.h.playerPos();
    const d = districtAt(pp.x, pp.z);
    const out = [...base];
    // what they are doing right now, so nobody pretends to be at a counter that isn't there
    const r = t ? this.regularOf(t) : null;
    const here = t?.inside ? this.places.get(t.inside)?.place.name ?? 'the shop' : null;
    if (r || (t && t.role === 'clerk')) out.unshift(`Right now: you are at work, behind the counter inside ${here ?? this.places.get(r!.home)?.place.name ?? 'your place'}. The courier has walked in out of the rain. Anything you sell or hand over, you have here.`);
    else if (t?.inside) out.unshift(`Right now: you are a customer inside ${here}, out of the rain. You do not work here, so you cannot sell anything or speak for the shop.`);
    else if (t) out.unshift(`Right now: you were ${t.prevState === 'phone' ? 'standing on the sidewalk looking at your phone' : t.prevState === 'idle' ? 'standing on the sidewalk' : 'walking along the sidewalk'} when the courier stopped you. You are NOT at your workplace: there is no shop, stall, counter or menu here, and you have nothing to sell or hand over except what you carry (phone, bag, keys).`);
    out.push(`How people around here talk about the courier: ${repLabel(this.h.save.rep[d] ?? 0)}`);
    if (p.id.startsWith('regular:')) {
      const m = this.h.save.npc[p.id];
      if (m && (m.met || m.jobsDone || m.jobsFailed)) {
        out.push(`You know this courier: you have talked ${m.met} time${m.met === 1 ? '' : 's'}; they have done ${m.jobsDone} job${m.jobsDone === 1 ? '' : 's'} for you${m.jobsFailed ? ` and let you down ${m.jobsFailed} time${m.jobsFailed === 1 ? '' : 's'}` : ''}. Overall ${relLabel(m.rel)}.`);
      } else out.push('You have never met this courier before.');
    }
    if (this.active?.giverId === p.id) out.push(`The courier is in the middle of your job right now (${this.title(this.active.job)}).`);
    return out;
  }

  // ---------------------------------------------------------------- jobs
  private title(j: Job) {
    const name = this.places.get(j.place)?.place.name ?? 'somewhere';
    return j.kind === 'deliver' ? `Take ${j.item} to ${name}` : `Fetch ${j.item} from ${name}`;
  }
  job(t: Talker, p: Persona) {
    const j = this.jobOf(t, this.regularOf(t));
    return j ? { title: this.title(j.job), pay: j.pay } : null;
  }

  acceptJob(t: Talker, p: Persona) {
    const r = this.regularOf(t);
    const j = this.jobOf(t, r);
    if (!j) return;
    const dest = this.places.get(j.job.place)!;
    const back = j.from.clone();
    const giverName = p.name.split(' ')[0] === 'Mr.' || p.name.split(' ')[0] === 'Mrs.' ? p.name : p.name.split(' ')[0];
    const pay = j.pay;
    const giverPlace = r ? r.home : t.inside ?? null; // regulars and clerks are inside their place
    const giverDistrict = giverPlace ? this.places.get(giverPlace)!.place.district : districtAt(back.x, back.z);
    const item = j.job.item;
    const def: MissionDef = {
      id: `street_${p.id}`, n: 0, title: this.title(j.job), district: dest.place.district, type: 'Street', desc: '', reward: pay, unlock: [],
      build: (c) => {
        // the hand-over / pick-up happens at the counter inside the place
        const atCounter = (placeId: string, label: string, prompt: string, sfx: 'pickup' | 'cash' = 'pickup') => {
          let done = false;
          const name = this.places.get(placeId)!.place.name;
          return {
            prompt: () => (this.h.inside() === placeId ? prompt : `Go inside ${name}`),
            at: () => (this.h.inside() === placeId ? this.h.counter(placeId) : this.places.get(placeId)!.stand),
            marker: 'ring' as const,
            time: 'keep' as const,
            start: () => { c.interaction = { at: this.h.counter(placeId), label, run: () => { done = true; c.sfx(sfx); } }; },
            check: () => { if (done) { c.interaction = null; return true; } return false; },
          };
        };
        const door = (placeId: string) => this.places.get(placeId)!.stand;
        const steps = j.job.kind === 'deliver'
          ? [
            c.goto(door(dest.place.id), `Take ${item} to ${dest.place.name}`, { marker: 'drop', radius: 5, time: c.legTime(back, dest.curb, 10, 50) }),
            atCounter(dest.place.id, `Hand over ${item}`, `Hand ${item} over at the counter`),
          ]
          : [
            c.goto(door(dest.place.id), `Pick up ${item} at ${dest.place.name}`, { marker: 'pickup', radius: 5, time: c.legTime(back, dest.curb, 10, 50) }),
            atCounter(dest.place.id, `Collect ${item}`, `Collect ${item} at the counter`),
            ...(giverPlace
              ? [
                c.goto(door(giverPlace), `Bring ${item} back to ${giverName}`, { marker: 'drop', radius: 5, time: c.legTime(dest.curb, back, 10, 50) }),
                atCounter(giverPlace, `Give ${item} to ${giverName}`, `Give ${item} to ${giverName} at the counter`),
              ]
              : [c.goto(back, `Bring ${item} back to ${giverName}`, { marker: 'drop', radius: 8, time: c.legTime(dest.curb, back, 10, 45) })]),
          ];
        return { steps };
      },
      street: { onFinish: (ok, why, left) => this.finishJob(ok, why, left) },
    };
    this.active = { giverId: p.id, giverName, giverDistrict, job: j.job, pay, regular: r, def };
    this.h.suspendDeliveries(true);
    this.h.campaign.start(def);
  }

  private finishJob(ok: boolean, why: string | undefined, left: number) {
    const a = this.active;
    this.active = null;
    if (!a) return;
    const s = this.h.save;
    const where = this.places.get(a.job.place)!.place;
    if (ok) {
      const bonus = Math.round(Math.max(0, left) * 4);
      s.credits += a.pay + bonus;
      this.h.hud.setCredits(s.credits);
      this.h.hud.toast(`Job done for ${a.giverName} · +${a.pay + bonus} CR`, 4);
      setTimeout(() => this.h.audio.play('cash'), 600);
      addRep(s, a.giverDistrict, 6);
      addRep(s, where.district, 2);
      this.note(a.giverId, `The courier did your job tonight: ${a.job.kind === 'deliver' ? `delivered ${a.job.item} to ${where.name}` : `brought back ${a.job.item} from ${where.name}`}, on time.`, 1, true);
    } else {
      this.h.hud.toast(`Job failed${why === 'busted' ? ' · busted' : ' · out of time'}`, 4);
      addRep(s, a.giverDistrict, -3);
      this.note(a.giverId, `The courier took your job (${a.job.item}) and failed it${why === 'busted' ? ' after getting caught by the police' : ', too slow'}.`, -1, false);
    }
    writeSave(s);
    this.h.suspendDeliveries(false);
  }

  /** Something the courier did that the district hears about. */
  repEvent(kind: 'delivery' | 'carjack' | 'hit' | 'busted' | 'assault', pos: THREE.Vector3) {
    const d = districtAt(pos.x, pos.z);
    addRep(this.h.save, d, { delivery: 3, carjack: -6, hit: -8, busted: -2, assault: -5 }[kind]);
    writeSave(this.h.save);
  }
}

export { PLACES };
