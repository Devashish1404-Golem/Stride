// Periodised training-plan generator: base -> build -> peak -> taper -> race.
// Workouts store pace *zones*, not paces, so updating fitness (VDOT) re-paces the whole plan.

import { addDays, mondayOf, dow, daysBetween, today, clamp, sum, round1 } from './util.js';
import { DISTANCES, paces } from './vdot.js';
import { gymSession } from './gym.js';

const GOALS = {
  marathon: { taper: [0.75, 0.6, 0.35], peakLong: 32, mult: 1.6, minPeak: 50, longCap: 0.55 },
  half: { taper: [0.7, 0.45], peakLong: 21, mult: 1.45, minPeak: 35, longCap: 0.45 },
  '10k': { taper: [0.6], peakLong: 16, mult: 1.35, minPeak: 30, longCap: 0.4 },
  '5k': { taper: [0.6], peakLong: 13, mult: 1.3, minPeak: 25, longCap: 0.4 },
};
const MAX_WEEKS = 24;

// ---------- step builders ----------
const step = (label, zone, o) => ({ label, zone, ...o });
const wu = (km = 2) => step('Warm up', 'E', { dist: km * 1000 });
const cd = (km = 1.5) => step('Cool down', 'E', { dist: km * 1000 });
function repeat(n, work, rec) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ ...work, label: `${work.label} ${i}/${n}` });
    if (rec && i < n) out.push({ ...rec });
  }
  return out;
}
const fmtDist = (m) => (m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${m} m`);
const fmtTime = (s) => (s >= 60 ? `${+(s / 60).toFixed(1)} min` : `${s} s`);
const dLabel = (o) => (o.dist ? fmtDist(o.dist) : fmtTime(o.time));

export function estimateKm(steps, p) {
  return round1(sum(steps, (s) => (s.dist ? s.dist / 1000 : s.time / ((p[s.zone].lo + p[s.zone].hi) / 2))));
}

// ---------- workout library ----------
const pick = (arr, lvl) => arr[clamp(Math.round(lvl * (arr.length - 1)), 0, arr.length - 1)];

function easyRun(km, strides = false) {
  const steps = [step('Easy run', 'E', { dist: Math.round(km * 1000) })];
  if (strides) steps.push(...repeat(6, step('Stride', 'R', { time: 20 }), step('Walk back', 'Rec', { time: 60 })));
  return {
    type: 'easy', title: strides ? 'Easy + Strides' : 'Easy Run',
    summary: `${round1(km)} km easy${strides ? ' + 6 × 20 s strides' : ''}`,
    purpose: strides
      ? 'Aerobic base plus fast, relaxed strides to keep your legs turning over without adding fatigue.'
      : 'Builds aerobic capacity, capillaries and durability. Keep it truly conversational.',
    steps,
  };
}

function longRun(km, fastKm = 0, fastZone = 'M') {
  const steps = fastKm
    ? [step('Long run', 'E', { dist: Math.round((km - fastKm) * 1000) }), step(`Fast finish`, fastZone, { dist: fastKm * 1000 })]
    : [step('Long run', 'E', { dist: Math.round(km * 1000) })];
  return {
    type: 'long', title: fastKm ? 'Long Run, Fast Finish' : 'Long Run',
    summary: fastKm ? `${round1(km)} km with the last ${fastKm} km at ${fastZone === 'M' ? 'marathon' : 'race'} pace` : `${round1(km)} km easy`,
    purpose: fastKm
      ? 'Teaches you to run goal pace on tired legs. This is the most race-specific session in the plan.'
      : 'The cornerstone of endurance. Builds fat oxidation, glycogen storage and mental toughness. Practise fuelling on runs over 90 minutes.',
    steps,
  };
}

function hills(lvl) {
  const n = pick([6, 7, 8, 9, 10], lvl);
  return {
    type: 'hills', title: 'Hill Repeats',
    summary: `${n} × 60 s uphill, hard, jog down`,
    purpose: 'Strength in disguise. Builds power and running economy with low impact.',
    steps: [wu(2), ...repeat(n, step('Hill', 'I', { time: 60 }), step('Jog down', 'Rec', { time: 90 })), cd(1.5)],
  };
}

const INTERVALS = [[5, 800, 400], [6, 800, 400], [5, 1000, 400], [6, 1000, 400], [5, 1200, 400], [4, 1600, 600], [5, 1600, 600]];
function intervals(lvl, light = false) {
  let [n, d, r] = pick(INTERVALS, lvl);
  if (light) n = Math.max(3, n - 2);
  return {
    type: 'intervals', title: 'Intervals',
    summary: `${n} × ${fmtDist(d)} @ interval pace, ${fmtDist(r)} jog`,
    purpose: 'Raises VO₂max, the ceiling of your aerobic engine. Run the reps evenly, not flat out.',
    steps: [wu(2), ...repeat(n, step('Rep', 'I', { dist: d }), step('Jog', 'Rec', { dist: r })), cd(1.5)],
  };
}

const TEMPOS = [[1, 900, 0], [1, 1200, 0], [2, 720, 120], [1, 1500, 0], [3, 600, 120], [1, 1800, 0], [2, 1200, 180]];
function tempo(lvl, light = false) {
  let [n, t, r] = pick(TEMPOS, light ? lvl * 0.5 : lvl);
  const work = repeat(n, step('Tempo', 'T', { time: t }), r ? step('Easy jog', 'Rec', { time: r }) : null);
  return {
    type: 'tempo', title: n > 1 ? 'Threshold Intervals' : 'Tempo Run',
    summary: n > 1 ? `${n} × ${fmtTime(t)} @ threshold, ${fmtTime(r)} jog` : `${fmtTime(t)} continuous @ threshold`,
    purpose: 'Pushes your lactate threshold up so you can hold faster paces for longer. Comfortably hard, never all-out.',
    steps: [wu(2), ...work, cd(1.5)],
  };
}

const CRUISE = [[3, 1600], [4, 1600], [3, 2000], [4, 2000], [3, 3000]];
function cruise(lvl, light = false) {
  let [n, d] = pick(CRUISE, lvl);
  if (light) n = Math.max(2, n - 1);
  return {
    type: 'tempo', title: 'Cruise Intervals',
    summary: `${n} × ${fmtDist(d)} @ threshold, 60 s jog`,
    purpose: 'Threshold work split into chunks so you can accumulate more time at a high, sustainable effort.',
    steps: [wu(2), ...repeat(n, step('Cruise', 'T', { dist: d }), step('Jog', 'Rec', { time: 60 })), cd(1.5)],
  };
}

function racePaceRun(goal, lvl, light = false) {
  if (goal === 'marathon') {
    const km = light ? 6 : Math.round(8 + lvl * 8);
    return {
      type: 'mp', title: 'Marathon Pace Run',
      summary: `${km} km @ marathon pace`,
      purpose: 'Locks goal pace into your legs. Practise race-day fuelling and drinking on the move.',
      steps: [wu(2), step('Marathon pace', 'M', { dist: km * 1000 }), cd(1.5)],
    };
  }
  const opts = { half: [[3, 3000], [4, 3000], [3, 4000], [2, 5000]], '10k': [[4, 1600], [5, 1600], [3, 2000], [4, 2000]], '5k': [[5, 800], [6, 800], [5, 1000], [4, 1200]] }[goal];
  let [n, d] = pick(opts, lvl);
  if (light) n = Math.max(2, n - 1);
  return {
    type: 'mp', title: 'Race Pace Reps',
    summary: `${n} × ${fmtDist(d)} @ goal race pace`,
    purpose: 'Rehearse your race rhythm until goal pace feels familiar and controlled.',
    steps: [wu(2), ...repeat(n, step('Race pace', 'RP', { dist: d }), step('Jog', 'Rec', { time: 90 })), cd(1.5)],
  };
}

function shakeout() {
  return {
    type: 'easy', title: 'Shakeout',
    summary: '20 min very easy + 4 strides',
    purpose: 'Loosen up, settle the nerves. Lay out your kit tonight.',
    steps: [step('Easy jog', 'E', { time: 1200 }), ...repeat(4, step('Stride', 'R', { time: 15 }), step('Walk', 'Rec', { time: 45 }))],
  };
}

function raceDay(goal) {
  const d = DISTANCES[goal];
  return {
    type: 'race', title: `Race Day: ${d.label}`,
    summary: `${d.label}. Trust the training.`,
    purpose: goal === 'marathon'
      ? 'Start at the slow end of marathon pace for the first 5 km. Fuel every 30–40 min from the start. Race the last 10 km.'
      : 'Start controlled, settle into goal pace, and push once you are past halfway.',
    steps: [step(d.label, 'RP', { dist: d.m })],
  };
}

// ---------- scheduling ----------
const circ = (a, b) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
function spreadDays(runDays, longDay, count) {
  const chosen = [longDay];
  const picks = [];
  for (let k = 0; k < count; k++) {
    const cands = runDays.filter((d) => !chosen.includes(d));
    if (!cands.length) break;
    cands.sort((a, b) => Math.min(...chosen.map((c) => circ(b, c))) - Math.min(...chosen.map((c) => circ(a, c))) || a - b);
    chosen.push(cands[0]);
    picks.push(cands[0]);
  }
  return picks;
}

export function phaseLayout(n, taperLen) {
  const t = Math.min(taperLen, n);
  const rest = n - t;
  const peak = rest >= 6 ? Math.min(3, Math.round(rest * 0.2)) : rest >= 3 ? 1 : 0;
  const base = Math.round((rest - peak) * 0.4);
  const build = rest - peak - base;
  return [...Array(base).fill('base'), ...Array(build).fill('build'), ...Array(peak).fill('peak'), ...Array(t).fill('taper')];
}

export function generatePlan(profile) {
  const g = GOALS[profile.goal];
  const p = paces(profile.vdot, DISTANCES[profile.goal].m);
  const raceMon = mondayOf(profile.raceDate);
  let start = mondayOf(today());
  let n = daysBetween(start, raceMon) / 7 + 1;
  if (n > MAX_WEEKS) { start = addDays(raceMon, -7 * (MAX_WEEKS - 1)); n = MAX_WEEKS; }
  n = Math.max(1, n);

  const phases = phaseLayout(n, g.taper.length);
  const nonTaper = phases.filter((x) => x !== 'taper').length;
  const peakStart = phases.indexOf('peak') >= 0 ? phases.indexOf('peak') : nonTaper;
  const runDays = [...profile.runDays].sort((a, b) => a - b);
  const longDay = runDays.includes(profile.longRunDay) ? profile.longRunDay : runDays[runDays.length - 1];
  const scale = profile.volumeScale ?? 1;
  const beginner = profile.experience === 'beginner';

  const startVol = Math.max(profile.weeklyKm, runDays.length * 5);
  let peakVol = Math.max(startVol * g.mult, g.minPeak);
  peakVol = Math.min(peakVol, startVol * Math.pow(1.08, Math.max(1, peakStart)), runDays.length * 17);
  peakVol = Math.max(peakVol, startVol);
  const longStart = clamp(Math.max(profile.longestKm || 0, startVol * 0.3), 5, g.peakLong);

  const nQual = runDays.length >= 4 ? 2 : runDays.length >= 2 ? 1 : 0;
  const [q1Day, q2Day] = spreadDays(runDays, longDay, nQual);
  const gymDays = [...(profile.gymDays || [])].sort((a, b) => a - b);

  const weeks = [];
  const todayStr = today();
  let gymToggle = 0;
  for (let w = 0; w < n; w++) {
    const phase = phases[w];
    const monday = addDays(start, w * 7);
    const isRaceWeek = w === n - 1;
    const taperIdx = phase === 'taper' ? w - (n - g.taper.length) : -1;
    const f = peakStart > 1 ? Math.min(1, w / (peakStart - 1)) : 1;
    const cutback = phase !== 'peak' && phase !== 'taper' && w > 0 && (w + 1) % 4 === 0;

    // progress within the current phase (0..1) drives workout difficulty
    const pStart = phases.indexOf(phase), pLen = phases.filter((x) => x === phase).length;
    const lvl = pLen > 1 ? (w - pStart) / (pLen - 1) : 0.5;
    const light = cutback || phase === 'taper';

    let vol = phase === 'taper' ? peakVol * g.taper[Math.max(0, taperIdx)] : w >= peakStart ? peakVol : startVol + (peakVol - startVol) * f;
    if (cutback) vol *= 0.8;
    vol *= scale;

    let longKm;
    if (phase === 'taper') longKm = g.peakLong * (taperIdx === 0 ? 0.68 : 0.5);
    else if (phase === 'peak') longKm = g.peakLong - ((w - peakStart) % 2 ? 3 : 0);
    else longKm = longStart + (g.peakLong - longStart) * f;
    if (cutback) longKm *= 0.75;
    longKm = Math.round(Math.min(longKm, Math.max(vol * g.longCap, 8)) * scale);

    const sessions = {}; // dow -> workout
    if (!isRaceWeek) {
      const fastFinish = (phase === 'build' || phase === 'peak') && !cutback && w % 2 === 1;
      const fastKm = fastFinish ? (profile.goal === 'marathon' ? (phase === 'peak' ? 10 : 6) : 3) : 0;
      sessions[longDay] = longRun(longKm, fastKm, profile.goal === 'marathon' ? 'M' : 'RP');
      if (q1Day !== undefined) {
        sessions[q1Day] = phase === 'base'
          ? (beginner || w % 2 === 0 ? easyRun(Math.max(5, vol * 0.15), true) : hills(lvl))
          : phase === 'build' ? intervals(lvl, light)
          : phase === 'peak' ? (w % 2 ? cruise(lvl) : intervals(1, false))
          : intervals(0.4, true);
      }
      if (q2Day !== undefined) {
        sessions[q2Day] = phase === 'base'
          ? (beginner || lvl < 0.5 ? easyRun(Math.max(5, vol * 0.15), true) : tempo(0, true))
          : phase === 'build' ? tempo(lvl, light)
          : phase === 'peak' ? racePaceRun(profile.goal, lvl)
          : racePaceRun(profile.goal, 0, true);
      }
      const easyDays = runDays.filter((d) => !sessions[d]);
      const used = sum(Object.values(sessions), (s) => estimateKm(s.steps, p));
      const each = easyDays.length ? clamp((vol - used) / easyDays.length, 4, Math.max(5, longKm * 0.75)) : 0;
      for (const d of easyDays) sessions[d] = easyRun(Math.round(each * 2) / 2, (phase === 'build' || phase === 'peak') && d === easyDays[easyDays.length - 1]);
    } else {
      // race week: short easy runs, one sharpener, shakeout, race
      const raceDow = dow(profile.raceDate);
      const before = runDays.filter((d) => d < raceDow - 1);
      before.forEach((d, i) => {
        sessions[d] = i === 0 && before.length > 1
          ? { ...racePaceRun(profile.goal, 0, true), title: 'Sharpener', summary: 'Short race-pace reminder' }
          : easyRun(Math.max(4, Math.round(vol / Math.max(2, before.length + 1))));
      });
      if (raceDow > 0) sessions[raceDow - 1] = shakeout();
      sessions[raceDow] = raceDay(profile.goal);
    }

    const workouts = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      if ((isRaceWeek && date > profile.raceDate) || date < todayStr) continue;
      const s = sessions[d];
      if (s) {
        if (s.type === 'race') s.steps[0].zone = profile.goal === 'marathon' ? 'M' : 'RP';
        workouts.push({ id: `${date}:run`, date, kind: 'run', phase, ...s, km: estimateKm(s.steps, p) });
      }
      if (gymDays.includes(d) && !isRaceWeek) {
        // Keep the day before a long run or key session light.
        const nextKey = [longDay, q1Day].includes((d + 1) % 7);
        const variant = gymToggle++ % 2 ? 'B' : 'A';
        const gs = gymSession(cutback ? 'peak' : phase, variant, nextKey);
        workouts.push({ id: `${date}:gym`, date, kind: 'gym', type: 'gym', phase, ...gs, summary: `${gs.items.length} exercises · ~${gs.sessionKey.startsWith('mobility') ? 20 : 45} min` });
      }
    }
    weeks.push({
      index: w + 1, start: monday, phase, cutback,
      plannedKm: round1(sum(workouts.filter((x) => x.kind === 'run'), (x) => x.km)),
      workouts,
    });
  }
  return { createdAt: today(), start, raceDate: profile.raceDate, goal: profile.goal, weeks };
}

// Keep the past exactly as it was; replace only today onward.
export function mergePlans(oldPlan, newPlan) {
  if (!oldPlan) return newPlan;
  const t = today();
  const oldPast = new Map(oldPlan.weeks.flatMap((w) => w.workouts).filter((x) => x.date < t).map((x) => [x.id, x]));
  for (const wk of newPlan.weeks) {
    const past = [...oldPast.values()].filter((x) => x.date >= wk.start && x.date < addDays(wk.start, 7));
    wk.workouts = [...past, ...wk.workouts.filter((x) => x.date >= t)].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'run' ? -1 : 1));
    wk.plannedKm = round1(sum(wk.workouts.filter((x) => x.kind === 'run'), (x) => x.km));
  }
  return newPlan;
}

export const allWorkouts = (plan) => (plan ? plan.weeks.flatMap((w) => w.workouts) : []);
export const weekOf = (plan, date) => plan?.weeks.find((w) => date >= w.start && date < addDays(w.start, 7));

export function swapToEasy(w, p) {
  const e = easyRun(Math.max(4, Math.round(w.km * 0.7)));
  return { ...w, ...e, title: 'Easy Run (swapped)', km: estimateKm(e.steps, p), swappedFrom: w.title };
}

export { easyRun, step };
