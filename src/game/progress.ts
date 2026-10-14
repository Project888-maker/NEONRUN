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
  settings: { quality: QualityLevel | 'auto'; master: number; music: number; sfx: number; cam: 'chase' | 'far' | 'hood' };
}

const KEY = 'neonrun.save.v1';
export const UPGRADE_COST = [600, 1400, 2800];
export const UNLOCK_AT: Record<DistrictId, number> = { neon: 0, backstreets: 3, downtown: 6, docks: 10 };

const defaults = (): Save => ({
  credits: 300, deliveries: 0, bestStreak: 0, unlocked: ['neon'],
  upgrades: { speed: 0, grip: 0, boost: 0 }, paint: 'gunmetal', underglow: '#21f3ff', livery: null,
  settings: { quality: 'auto', master: 0.9, music: 0.55, sfx: 0.9, cam: 'chase' },
});

export function loadSave(): Save {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const d = defaults();
    const s = JSON.parse(raw);
    return { ...d, ...s, upgrades: { ...d.upgrades, ...s.upgrades }, settings: { ...d.settings, ...s.settings } };
  } catch { return defaults(); }
}
export function writeSave(s: Save) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
