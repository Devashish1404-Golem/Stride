// The coach: turns your logged runs, plan adherence and Fitbit recovery data into suggestions.

import { today, addDays, mondayOf, daysBetween, sum, round1, fmtPace, fmtDur, fmtDate } from './util.js';
import { vdotFrom, paces, predictTime, DISTANCES } from './vdot.js';
import { allWorkouts, weekOf } from './plan.js';

const QUALITY = new Set(['intervals', 'tempo', 'mp', 'hills', 'race']);

export const currentPaces = (s) => paces(s.profile.vdot, DISTANCES[s.profile.goal].m);
export const runKmBetween = (runs, from, to) => round1(sum(runs.filter((r) => r.date >= from && r.date <= to), (r) => r.distKm));
export const workoutById = (s, id) => allWorkouts(s.plan).find((w) => w.id === id);

// Attach a run to the matching planned run on its day, if it's still open.
export function matchRun(s, run) {
  if (run.workoutId) return;
  const w = allWorkouts(s.plan).find((x) => x.kind === 'run' && x.date === run.date && !s.completions[x.id]);
  if (w) {
    run.workoutId = w.id;
    s.completions[w.id] = { status: 'done', runId: run.id };
  }
}

export function readiness(s) {
  const t = today();
  const rhrToday = s.fitbit.rhr[t] ?? s.fitbit.rhr[addDays(t, -1)];
  const base = [];
  for (let i = 2; i <= 15; i++) { const v = s.fitbit.rhr[addDays(t, -i)]; if (v) base.push(v); }
  const sleepMin = s.fitbit.sleep[t];
  if (!rhrToday && !sleepMin) return null;
  const baseline = base.length >= 4 ? sum(base) / base.length : null;
  let score = 75;
  const notes = [];
  if (rhrToday && baseline) {
    const d = rhrToday - baseline;
    score -= d * 5;
    notes.push(d >= 3 ? `Resting HR is ${Math.round(d)} bpm above your baseline` : d <= -2 ? 'Resting HR is below baseline, a good sign' : 'Resting HR is at baseline');
  }
  if (sleepMin) {
    score += (sleepMin - 450) / 6;
    notes.push(`${Math.floor(sleepMin / 60)}h ${sleepMin % 60}m sleep`);
  }
  // recent load
  const acute = runKmBetween(s.runs, addDays(t, -3), addDays(t, -1));
  score -= Math.max(0, acute - 25) * 0.6;
  score = Math.round(Math.max(5, Math.min(100, score)));
  return { score, rhr: rhrToday, baseline: baseline && Math.round(baseline), sleepMin, notes, label: score >= 70 ? 'Ready to train' : score >= 50 ? 'Train with care' : 'Prioritise recovery' };
}

// Best recent performance → implied VDOT. Only fast efforts count, because easy runs say little about fitness.
export function fitnessEstimate(s) {
  const from = addDays(today(), -42);
  let best = null;
  for (const r of s.runs) {
    if (r.date < from || r.distKm < 3 || !r.durSec) continue;
    const w = r.workoutId && workoutById(s, r.workoutId);
    const hard = (w && QUALITY.has(w.type) && w.type !== 'hills') || (r.rpe ?? 0) >= 8 || r.isRace;
    if (!hard) continue;
    // a workout includes warm-up/cool-down jogging, so its whole-run average under-reads fitness: add a margin
    const v = vdotFrom(r.distKm * 1000, r.durSec) + (r.isRace ? 0 : 2.5);
    if (!best || v > best.vdot) best = { vdot: round1(v), run: r };
  }
  return best;
}

export function insights(s) {
  if (!s.profile || !s.plan) return [];
  const out = [];
  const t = today();
  const p = currentPaces(s);
  const workouts = allWorkouts(s.plan);
  const todays = workouts.find((w) => w.date === t && w.kind === 'run');
  const daysToRace = daysBetween(t, s.profile.raceDate);

  // 1. Recovery-driven swap
  const rd = readiness(s);
  if (rd && todays && QUALITY.has(todays.type) && todays.type !== 'race' && !s.completions[todays.id] && rd.score < 50) {
    out.push({ id: `swap-${t}`, level: 'alert', title: 'Swap today’s session for an easy run',
      body: `Readiness is ${rd.score}/100 (${rd.notes.join(', ')}). A quality session on a poor recovery day adds fatigue without much fitness. Run easy today and the plan carries on.`,
      action: { label: 'Swap to easy', do: 'swapEasy', arg: todays.id } });
  }

  // 2. Training load (acute:chronic ratio)
  const acute = runKmBetween(s.runs, addDays(t, -6), t);
  const chronic = runKmBetween(s.runs, addDays(t, -27), t) / 4;
  if (chronic >= 8) {
    const acwr = acute / chronic;
    if (acwr > 1.4) out.push({ id: `acwr-hi-${mondayOf(t)}`, level: 'warn', title: 'Load spike detected',
      body: `You've run ${acute} km in 7 days against a 4-week average of ${round1(chronic)} km/week (×${acwr.toFixed(2)}). Spikes above ×1.4 raise injury risk. Keep the next 2–3 runs fully easy.` });
    else if (acwr < 0.7 && daysToRace > 14) out.push({ id: `acwr-lo-${mondayOf(t)}`, level: 'info', title: 'Volume has dipped',
      body: `This week is at ${Math.round(acwr * 100)}% of your recent average. If you were ill or busy, ease back in. Don't try to make up missed kilometres in one go.` });
  }

  // 3. Plan adherence over the last 14 days
  const recent = workouts.filter((w) => w.kind === 'run' && w.date < t && w.date >= addDays(t, -14));
  if (recent.length >= 4) {
    const done = recent.filter((w) => s.completions[w.id]?.status === 'done').length;
    const rate = done / recent.length;
    if (rate < 0.6) out.push({ id: `adhere-${mondayOf(t)}`, level: 'warn', title: 'The plan may be too much right now',
      body: `You completed ${done} of ${recent.length} planned runs in the last two weeks. A plan you can actually follow beats an ambitious one. Reducing future volume by 15% keeps your progress on track.`,
      action: { label: 'Reduce plan 15%', do: 'scalePlan', arg: 0.85 } });
    else if (rate >= 0.9 && recent.length >= 6) out.push({ id: `adhere-good-${mondayOf(t)}`, level: 'good', title: 'Great consistency',
      body: `${done}/${recent.length} runs done in the last two weeks. Consistency is the single biggest predictor of race-day success.` });
  }

  // 4. Fitness change from fast efforts
  const fit = fitnessEstimate(s);
  if (fit && fit.vdot >= s.profile.vdot + 1) {
    out.push({ id: `vdot-up-${fit.vdot}`, level: 'good', title: 'You’re getting fitter: update your paces',
      body: `Your ${fit.run.distKm} km on ${fmtDate(fit.run.date)} suggests a fitness score (VDOT) of ~${fit.vdot}, up from ${s.profile.vdot}. New marathon prediction: ${fmtDur(predictTime(fit.vdot, 42195))}.`,
      action: { label: `Set VDOT to ${fit.vdot}`, do: 'setVdot', arg: fit.vdot } });
  }
  const recentQuality = s.runs.filter((r) => r.date >= addDays(t, -21) && r.workoutId && QUALITY.has(workoutById(s, r.workoutId)?.type) && workoutById(s, r.workoutId)?.type !== 'hills');
  if (recentQuality.length >= 3) {
    const vs = recentQuality.map((r) => vdotFrom(r.distKm * 1000, r.durSec) + 2.5);
    const maxV = Math.max(...vs);
    if (maxV < s.profile.vdot - 2.5) out.push({ id: `vdot-down-${mondayOf(t)}`, level: 'warn', title: 'Paces might be set too fast',
      body: `Your last ${recentQuality.length} quality sessions came in slower than prescribed. Lowering your VDOT to ${round1(maxV)} makes the sessions hit the right training effect instead of overreaching.`,
      action: { label: `Set VDOT to ${round1(maxV)}`, do: 'setVdot', arg: round1(maxV) } });
  }

  // 5. Easy runs too fast
  const easyRuns = s.runs.filter((r) => r.date >= addDays(t, -21) && r.workoutId && ['easy', 'long'].includes(workoutById(s, r.workoutId)?.type) && r.durSec && r.distKm);
  const tooFast = easyRuns.filter((r) => r.durSec / r.distKm < p.E.lo - 5);
  if (easyRuns.length >= 3 && tooFast.length / easyRuns.length >= 0.5) {
    out.push({ id: `easyfast-${mondayOf(t)}`, level: 'warn', title: 'Slow down your easy runs',
      body: `${tooFast.length} of your last ${easyRuns.length} easy/long runs were faster than ${fmtPace(p.E.lo)}/km. Easy runs build the aerobic base, and running them too hard leaves you flat for the key sessions. Aim for ${fmtPace(p.E.lo)}–${fmtPace(p.E.hi)}/km.` });
  }

  // 6. Missed long run last week
  const lastWeek = weekOf(s.plan, addDays(t, -7));
  const lr = lastWeek?.workouts.find((w) => w.type === 'long');
  if (lr && !s.completions[lr.id] && lr.date < t) {
    out.push({ id: `misslong-${lr.id}`, level: 'info', title: 'Missed last week’s long run',
      body: `Don't double up. Run this week's long run as planned. If it's a big jump from your recent longest run, cut it by 2–3 km.` });
  }

  // 7. Strength consistency
  const gymPlanned = workouts.filter((w) => w.kind === 'gym' && w.date < t && w.date >= addDays(t, -14));
  const gymDone = gymPlanned.filter((w) => s.completions[w.id]?.status === 'done').length;
  if (gymPlanned.length >= 2 && gymDone === 0) {
    out.push({ id: `gym-${mondayOf(t)}`, level: 'info', title: 'Don’t skip strength',
      body: 'No gym sessions logged in two weeks. Even 20 minutes of the A session (squats, calf raises, core) cuts injury risk and improves running economy.' });
  }

  // 8. Goal tracking
  const goalDist = DISTANCES[s.profile.goal].m;
  const pred = predictTime(s.profile.vdot, goalDist);
  if (s.profile.goalTime) {
    const gap = pred - s.profile.goalTime;
    out.push({ id: `goal-${mondayOf(t)}`, level: gap <= 0 ? 'good' : 'info', title: gap <= 0 ? 'On track for your goal' : 'Goal check',
      body: gap <= 0
        ? `Current fitness predicts ${fmtDur(pred)}, inside your ${fmtDur(s.profile.goalTime)} goal. Keep doing what you're doing.`
        : `Current fitness predicts ${fmtDur(pred)}, which is ${fmtDur(gap)} off your ${fmtDur(s.profile.goalTime)} goal. That gap usually closes during the build phase. Nail the threshold sessions.` });
  }

  // 9. Phase-specific coaching
  const wk = weekOf(s.plan, t);
  if (wk) {
    const tips = {
      base: 'Base phase: most running is easy. Build the habit and the volume. Strength sessions are the heaviest now.',
      build: 'Build phase: the key sessions get harder. Protect them with genuinely easy days and 7–9 h of sleep.',
      peak: 'Peak phase: your biggest weeks. Rehearse race nutrition on long runs and marathon-pace sessions.',
      taper: daysToRace <= 7 ? 'Race week: carb-load the last 2–3 days (8–10 g/kg), keep runs short, sleep lots. Nothing new on race day.' : 'Taper: volume drops but keep some intensity. Feeling sluggish is normal; fitness is locking in.',
    };
    out.push({ id: `phase-${wk.phase}-${wk.index}`, level: 'info', title: `Week ${wk.index} of ${s.plan.weeks.length}: ${wk.phase[0].toUpperCase() + wk.phase.slice(1)}${wk.cutback ? ' (recovery week)' : ''}`, body: wk.cutback ? 'Recovery week: volume drops ~20% so your body can absorb the last three weeks. Resist the urge to do more.' : tips[wk.phase] });
  }

  const order = { alert: 0, warn: 1, good: 2, info: 3 };
  return out.filter((i) => !s.dismissed[i.id]).sort((a, b) => order[a.level] - order[b.level]);
}
