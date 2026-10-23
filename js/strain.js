// WHOOP-style daily numbers: Strain (0–21, from heart-rate training load), Sleep performance
// (% of sleep need) and Recovery (readiness score, see coach.js) for any date.

import { addDays, today, sum, clamp } from './util.js';

const DEFAULT_MAX_HR = 190;

export function maxHrOf(s) {
  return s.profile?.maxHr || Math.max(0, ...s.runs.map((r) => r.maxHr || 0)) || DEFAULT_MAX_HR;
}
function restingHr(s, date) {
  for (let i = 0; i < 7; i++) { const v = s.fitbit.rhr[addDays(date, -i)]; if (v) return v; }
  return 60;
}

// Banister TRIMP: minutes × HR reserve × exponential intensity weighting.
// Without heart rate we fall back to perceived effort (RPE) or a moderate default.
export function runLoad(s, run) {
  const min = (run.durSec || 0) / 60;
  if (!min) return 0;
  if (run.avgHr) {
    const rhr = restingHr(s, run.date), max = maxHrOf(s);
    const hrr = clamp((run.avgHr - rhr) / Math.max(30, max - rhr), 0, 1);
    return min * hrr * 0.64 * Math.exp(1.92 * hrr);
  }
  const rpe = run.rpe || (run.isRace ? 9 : 5);
  return min * (0.25 + rpe * 0.11);
}
const gymLoad = (log) => 12 + 4 * sum(log.entries, (e) => e.sets.filter((x) => x.done).length) * 0.6;

const toStrain = (load) => +(21 * (1 - Math.exp(-load / 110))).toFixed(1);

export function dayStrain(s, date) {
  const load = sum(s.runs.filter((r) => r.date === date), (r) => runLoad(s, r)) + sum(s.gymLogs.filter((g) => g.date === date), gymLoad);
  return { strain: toStrain(load), load };
}

// Planned workout → expected strain, from time spent in each pace zone.
const ZONE_HRR = { E: 0.62, Rec: 0.5, M: 0.75, RP: 0.82, T: 0.85, I: 0.92, R: 0.95 };
export function plannedStrain(w, paces) {
  if (!w) return 0;
  if (w.kind === 'gym') return toStrain(w.sessionKey?.startsWith('mobility') ? 8 : 40);
  const load = sum(w.steps, (st) => {
    const sec = st.time || (st.dist / 1000) * ((paces[st.zone].lo + paces[st.zone].hi) / 2);
    const hrr = ZONE_HRR[st.zone] ?? 0.65;
    return (sec / 60) * hrr * 0.64 * Math.exp(1.92 * hrr);
  });
  return toStrain(load);
}

// Recommended strain band for the day, based on recovery (WHOOP-style).
export function targetStrain(recovery) {
  if (recovery == null) return null;
  if (recovery >= 67) return [14, 18];
  if (recovery >= 34) return [10, 14];
  return [4, 10];
}

export const SLEEP_NEED_MIN = 8 * 60;
export function sleepPerf(s, date = today()) {
  const min = s.fitbit.sleep[date];
  if (!min) return null;
  // extra need after a hard day (strain over 14 adds up to 45 min)
  const prevStrain = dayStrain(s, addDays(date, -1)).strain;
  const need = SLEEP_NEED_MIN + Math.max(0, prevStrain - 14) * 6;
  return { min, need, pct: Math.min(100, Math.round((min / need) * 100)) };
}

export const recoveryColor = (v) => (v == null ? 'var(--muted)' : v >= 67 ? 'var(--rec-green)' : v >= 34 ? 'var(--rec-yellow)' : 'var(--rec-red)');
