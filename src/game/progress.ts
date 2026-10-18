import type { DistrictId } from '../world/layout';
import type { QualityLevel } from '../core/quality';

export interface Save {
  credits: number;
  deliveries: number;
  bestStreak: number;
  unlocked: DistrictId[];
  upgrades: { speed: number; grip: number; boost: number };
  paint: string;
  underglow: string;
  livery: string | null;
  car: string; // 'hero' or a CAR_DEFS id
  ownedCars: string[];
  /** story campaign: completed mission ids and best times (s) */
  story: { done: string[]; best: Record<string, number> };
  settings: { quality: QualityLevel | 'auto'; master: number; music: number; sfx: number; cam: 'chase' | 'far' | 'hood'; voice?: 'on' | 'off'; language?: 'uncensored' | 'mild' };
  /** what the regulars remember about the courier (keyed by persona id) */
  npc: Record<string, NpcMemory>;
  /** how each district sees the courier, -100 (menace) .. 100 (local hero) */
  rep: Record<DistrictId, number>;
}

export interface NpcMemory {
  notes: string[];
  /** the last few lines exchanged, for continuity */
  last: { who: 'courier' | 'npc'; text: string }[];
  met: number;
  /** -5 (hates you) .. 5 (would trust you with anything) */
  rel: number;
  jobsDone: number;
  jobsFailed: number;
}

export const newMemory = (): NpcMemory => ({ notes: [], last: [], met: 0, rel: 0, jobsDone: 0, jobsFailed: 0 });

/** Change a district's opinion of the courier. */
export function addRep(s: Save, d: DistrictId, n: number) {
  s.rep[d] = Math.max(-100, Math.min(100, Math.round((s.rep[d] ?? 0) + n)));
}
/** How people in a district talk about the courier. */
export function repLabel(v: number) {
  return v <= -40 ? 'a menace people warn each other about' : v <= -12 ? 'trouble, known for reckless driving and worse' : v < 12 ? 'nobody in particular yet' : v < 40 ? 'a reliable courier people are starting to know' : 'a local legend, the courier everyone trusts';
}

const KEY = 'neonrun.save.v1';
export const UPGRADE_COST = [600, 1400, 2800];
export const UNLOCK_AT: Record<DistrictId, number> = { neon: 0, backstreets: 3, downtown: 6, docks: 10 };

const defaults = (): Save => ({
  credits: 300, deliveries: 0, bestStreak: 0, unlocked: ['neon'],
  upgrades: { speed: 0, grip: 0, boost: 0 }, paint: 'gunmetal', underglow: '#21f3ff', livery: null, car: 'hero', ownedCars: ['hero'], story: { done: [], best: {} },
  settings: { quality: 'auto', master: 0.9, music: 0.55, sfx: 0.9, cam: 'chase' },
  npc: {}, rep: { neon: 0, backstreets: 0, downtown: 0, docks: 0 },
});

export function loadSave(): Save {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const d = defaults();
    const s = JSON.parse(raw);
    return { ...d, ...s, upgrades: { ...d.upgrades, ...s.upgrades }, settings: { ...d.settings, ...s.settings }, story: { ...d.story, ...s.story }, npc: { ...s.npc }, rep: { ...d.rep, ...s.rep } };
  } catch { return defaults(); }
}
export function writeSave(s: Save) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
