import { $, $$, esc, today, addDays, fmtDate, fmtPace, fmtDur, parseDur, fmtKm, daysBetween, mondayOf, dow, DOW, DOW_LONG, round1, sum, uid, clamp } from './util.js';
import { state, save, replaceState, resetState, tombstone, onChange, DEFAULT_TILES } from './store.js';
import * as google from './google.js';
import { APP_VERSION } from './config.js';
import { syncNow } from './sync.js';
import { vdotFrom, vdotFromEasyPace, predictTime, DISTANCES, ZONES } from './vdot.js';
import { generatePlan, mergePlans, allWorkouts, weekOf, swapToEasy } from './plan.js';
import { EXERCISES, sessionByKey, allSessions, suggestLoad } from './gym.js';
import { insights, readiness, matchRun, currentPaces, runKmBetween, workoutById, fitnessEstimate, latestVsBaseline } from './coach.js';
import * as health from './health.js';
import { RunTracker, DEFAULT_VOICE, speak } from './tracker.js';
import { fmtD, fmtP, paceUnit, distUnit, toUnit, uText, isMi, KM_PER_MI } from './units.js';
import { dayStrain, plannedStrain, targetStrain, sleepPerf, recoveryColor, runLoad } from './strain.js';
import { routeSvg } from './route.js';
import * as strava from './strava.js';
import * as spotify from './spotify.js';

const app = $('#app');
const sheetEl = $('#sheet');
const trackerEl = $('#tracker');
let tab = localStorage.getItem('stride.tab') || 'today';
let tracker = null;
let editingProfile = false;

// ---------------- helpers ----------------
const TYPE_COLOR = { easy: 'var(--z-easy)', long: 'var(--z-long)', intervals: 'var(--z-i)', tempo: 'var(--z-t)', mp: 'var(--z-m)', hills: 'var(--z-r)', race: 'var(--accent)', gym: 'var(--gym)' };
const FOOTER = '<footer class="love">Made with <span aria-label="love">❤️</span> by Devashish</footer>';
const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const GOOGLE_G = '<svg class="ic" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
const avatar = () => state.auth?.picture
  ? `<img class="avatar" src="${esc(state.auth.picture)}" alt="" referrerpolicy="no-referrer">`
  : `<span class="avatar">${esc((state.auth?.name || state.auth?.email || '?')[0].toUpperCase())}</span>`;

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

function estSec(w, p) {
  return sum(w.steps || [], (s) => s.time || (s.dist / 1000) * ((p[s.zone].lo + p[s.zone].hi) / 2));
}
const paceRange = (z, p) => `${fmtP(p[z].lo)}–${fmtP(p[z].hi)}`;
const stepAmount = (s) => (s.dist ? (s.dist >= 1000 ? fmtD(s.dist / 1000) : `${s.dist} m`) : s.time >= 60 ? `${+(s.time / 60).toFixed(1)} min` : `${s.time} s`);

// Collapse "Rep 1/6, Jog, Rep 2/6 …" into one "6 ×" block for display.
function groupSteps(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const m = steps[i].label.match(/^(.*) 1\/(\d+)$/);
    if (m) {
      const n = +m[2];
      const rec = steps[i + 1] && !/\d+\/\d+$/.test(steps[i + 1].label) ? steps[i + 1] : null;
      out.push({ repeat: n, work: { ...steps[i], label: m[1] }, rec });
      i += n - 1 + (rec ? n - 1 : 0);
    } else out.push(steps[i]);
  }
  return out;
}

function stepRow(s, p) {
  return `<div class="step"><span class="zdot" style="background:${ZONES[s.zone].color}"></span>
    <div class="grow"><b>${esc(s.label)}</b> <span class="muted">${stepAmount(s)}</span></div>
    <div class="pace">${paceRange(s.zone, p)}<small>${paceUnit()}</small></div></div>`;
}

function stepsHtml(w, p) {
  return groupSteps(w.steps).map((g) => g.repeat
    ? `<div class="repeat"><div class="rep-h">${g.repeat} ×</div>${stepRow(g.work, p)}${g.rec ? stepRow(g.rec, p) : ''}</div>`
    : stepRow(g, p)).join('');
}

const statusOf = (w) => state.completions[w.id]?.status;
const runFor = (w) => state.runs.find((r) => r.id === state.completions[w.id]?.runId);

function workoutCard(w, p, opts = {}) {
  const st = statusOf(w);
  const color = TYPE_COLOR[w.type] || 'var(--muted)';
  const run = runFor(w);
  const est = w.kind === 'run' ? `${fmtD(w.km)} · ~${fmtDur(estSec(w, p)).replace(/:\d\d$/, '')} ${estSec(w, p) >= 3600 ? 'h' : 'min'}` : w.summary;
  return `<div class="wcard ${st || ''}" style="--c:${color}" data-act="${w.kind === 'gym' ? 'openGym' : 'openWorkout'}" data-id="${w.id}">
    <div class="wbar"></div>
    <div class="grow">
      ${opts.showDate ? `<div class="eyebrow">${fmtDate(w.date)}</div>` : ''}
      <div class="wtitle">${esc(w.title)} ${st === 'done' ? `<span class="chip good">${icon('check')} Done</span>` : st === 'skipped' ? '<span class="chip">Skipped</span>' : ''}</div>
      <div class="muted">${esc(w.kind === 'run' ? uText(w.summary) : est)}</div>
      ${w.kind === 'run' ? `<div class="meta">${run ? `${fmtD(run.distKm)} · ${fmtDur(run.durSec)} · ${fmtP(run.durSec / run.distKm)}${paceUnit()}` : est}</div>` : ''}
    </div>
    ${opts.cta && !st && w.date === today() ? `<button class="btn primary sm" data-act="${w.kind === 'gym' ? 'openGym' : 'startRun'}" data-id="${w.id}">${icon(w.kind === 'gym' ? 'dumbbell' : 'play')} Start</button>` : icon('chev')}
  </div>`;
}

function insightCard(i) {
  return `<div class="insight ${i.level}">
    <div class="ins-h"><b>${esc(i.title)}</b><button class="x" data-act="dismiss" data-id="${esc(i.id)}" aria-label="Dismiss">×</button></div>
    <p>${esc(i.body)}</p>
    ${i.action ? `<button class="btn sm ${i.level === 'alert' ? 'primary' : ''}" data-act="insight" data-do="${i.action.do}" data-arg="${esc(i.action.arg)}">${esc(i.action.label)}</button>` : ''}
  </div>`;
}

function openSheet(html, cls = '') {
  sheetEl.innerHTML = `<div class="backdrop" data-act="closeSheet"></div><div class="panel ${cls}"><div class="grab"></div>${html}</div>`;
  sheetEl.classList.add('open');
  document.body.classList.add('noscroll');
}
function closeSheet() {
  sheetEl.classList.remove('open');
  document.body.classList.remove('noscroll');
  setTimeout(() => { if (!sheetEl.classList.contains('open')) sheetEl.innerHTML = ''; }, 250);
}

// ---------------- onboarding / profile ----------------
function renderOnboarding() {
  const pr = state.profile || {};
  const nextSunday = addDays(mondayOf(today()), 7 * 18 + 6);
  const days = (sel, key, def) => DOW.map((d, i) => `<label class="daypick"><input type="checkbox" name="${key}" value="${i}" ${(pr[key] || def).includes(i) ? 'checked' : ''}><span>${d[0]}</span></label>`).join('');
  app.innerHTML = `<div class="onb">
    <div class="brand">${icon('logo')} <span>Stride</span></div>
    <h1>${editingProfile ? 'Edit your plan' : 'Let’s build your plan'}</h1>
    <p class="muted">${editingProfile ? 'Changes rebuild everything from today on. Past workouts and logs are kept.' : 'A few questions and you get a periodised running and strength plan with paces calibrated to you.'}</p>
    ${!editingProfile ? (google.signedIn(state)
      ? `<section class="card account mini">${avatar()}<div class="grow"><b>Signed in as ${esc(state.auth.email)}</b><div class="muted small">${syncing ? 'Checking your account for a saved plan…' : 'No saved plan on your account yet. Create one below and it syncs to all your devices.'}</div></div></section>`
      : `<section class="card signin">
          <button class="btn gsi block" data-act="signIn">${GOOGLE_G} Sign in with Google</button>
          <p class="muted small center">Stay signed in and sync your plan, runs and gym logs across all your devices. Already using Stride? Sign in to restore everything.</p>
          <div class="or"><span>or set up without an account</span></div>
        </section>`) : ''}
    <form id="onb">
      <section class="card">
        <h3>Your race</h3>
        <label>Name<input name="name" value="${esc(pr.name || '')}" placeholder="Your first name" autocomplete="given-name"></label>
        <div class="row2">
          <label>Distance<select name="goal">${Object.entries(DISTANCES).map(([k, d]) => `<option value="${k}" ${(pr.goal || 'marathon') === k ? 'selected' : ''}>${d.label}</option>`).join('')}</select></label>
          <label>Race date<input type="date" name="raceDate" required value="${pr.raceDate || nextSunday}" min="${addDays(today(), 7)}"></label>
        </div>
        <label>Goal time <span class="muted">(optional, h:mm:ss)</span><input name="goalTime" inputmode="numeric" placeholder="3:45:00" value="${pr.goalTime ? fmtDur(pr.goalTime) : ''}"></label>
      </section>
      <section class="card">
        <h3>Current fitness</h3>
        <p class="muted small">A recent race or hard time trial gives the most accurate paces.</p>
        <div class="row2">
          <label>Recent result<select name="recentDist"><option value="">None</option>${Object.entries(DISTANCES).map(([k, d]) => `<option value="${k}" ${pr.recentDist === k ? 'selected' : ''}>${d.label}</option>`).join('')}</select></label>
          <label>Time<input name="recentTime" inputmode="numeric" placeholder="25:30" value="${esc(pr.recentTime || '')}"></label>
        </div>
        <label>…or your comfortable easy pace <span class="muted">(min/km)</span><input name="easyPace" inputmode="numeric" placeholder="6:15" value="${esc(pr.easyPace || '')}"></label>
        <div class="row2">
          <label>Weekly km now<input type="number" name="weeklyKm" min="0" max="250" value="${pr.weeklyKm ?? 25}"></label>
          <label>Longest recent run (km)<input type="number" name="longestKm" min="0" max="60" value="${pr.longestKm ?? 12}"></label>
        </div>
        <label>Max heart rate <span class="muted">(optional, bpm; otherwise taken from your Fitbit runs)</span><input type="number" name="maxHr" min="120" max="230" inputmode="numeric" value="${pr.maxHr ?? ''}"></label>
        <label>Experience<select name="experience">${['beginner', 'intermediate', 'advanced'].map((x) => `<option ${(pr.experience || 'intermediate') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      </section>
      <section class="card">
        <h3>Your week</h3>
        <label>Run days</label><div class="days">${days('', 'runDays', [1, 3, 5, 6])}</div>
        <label>Long run day<select name="longRunDay">${DOW_LONG.map((d, i) => `<option value="${i}" ${(pr.longRunDay ?? 6) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label>Gym days</label><div class="days gym">${days('', 'gymDays', [0, 3])}</div>
        <p class="muted small">Tip: pair gym with hard run days so easy days stay easy. The day before a long run always gets a light mobility session.</p>
      </section>
      <button class="btn primary block" type="submit">${editingProfile ? 'Rebuild my plan' : 'Create my plan'}</button>
      ${editingProfile ? '<button class="btn block ghost" type="button" data-act="cancelEdit">Cancel</button>' : ''}
    </form>${FOOTER}</div>`;
  $('#onb').addEventListener('submit', onboardSubmit);
}

function onboardSubmit(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const runDays = f.getAll('runDays').map(Number);
  const gymDays = f.getAll('gymDays').map(Number);
  if (runDays.length < 2) return toast('Pick at least 2 run days');
  const goal = f.get('goal');
  const recentDist = f.get('recentDist'), recentTime = f.get('recentTime'), easyPace = f.get('easyPace');
  let vdot = state.profile?.vdot || 38;
  if (recentDist && parseDur(recentTime) > 0) vdot = vdotFrom(DISTANCES[recentDist].m, parseDur(recentTime));
  else if (parseDur(easyPace) > 0) vdot = vdotFromEasyPace(parseDur(easyPace));
  vdot = round1(clamp(vdot, 22, 85));
  let longRunDay = Number(f.get('longRunDay'));
  if (!runDays.includes(longRunDay)) runDays.push(longRunDay);
  const goalTime = parseDur(f.get('goalTime'));
  state.profile = {
    ...(state.profile || {}),
    name: f.get('name').trim(), goal, raceDate: f.get('raceDate'), goalTime: goalTime > 0 ? goalTime : null,
    recentDist, recentTime, easyPace, vdot,
    maxHr: Number(f.get('maxHr')) || null,
    weeklyKm: Number(f.get('weeklyKm')) || 0, longestKm: Number(f.get('longestKm')) || 0,
    experience: f.get('experience'), runDays, longRunDay, gymDays, volumeScale: state.profile?.volumeScale ?? 1,
  };
  rebuildPlan();
  editingProfile = false;
  tab = 'today';
  render();
  toast('Plan ready');
}

function rebuildPlan() {
  state.plan = mergePlans(state.plan, generatePlan(state.profile));
  state.planAt = Date.now();
  save();
}

// ---------------- WHOOP-style building blocks ----------------
function ring(pct, color, value, label, sub = '', act = '') {
  const r = 42, c = 2 * Math.PI * r, off = c * (1 - clamp(pct || 0, 0, 1));
  return `<button class="wring" ${act ? `data-act="${act}"` : ''} style="--rc:${color}">
    <span class="rwrap"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="${r}" class="track"/><circle cx="50" cy="50" r="${r}" class="val" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
    <span class="rv">${value}</span></span><span class="rl">${label}</span>${sub ? `<span class="rs">${sub}</span>` : ''}</button>`;
}

const sleepSeries = () => Object.fromEntries(Object.entries(state.fitbit.sleep).map(([d, v]) => [d, round1(v / 60)]));
// Health metrics available for dashboard tiles and trend rows.
const METRIC_DEFS = {
  hrv: { label: 'HRV', unit: 'ms', series: () => state.fitbit.metrics?.hrv, color: 'var(--rec-green)', good: 'up' },
  rhr: { label: 'Resting HR', unit: 'bpm', series: () => state.fitbit.rhr, color: 'var(--rec-red)', good: 'down' },
  vo2max: { label: 'VO₂ max', unit: '', series: () => state.fitbit.metrics?.vo2max, color: 'var(--accent)', good: 'up' },
  sleep: { label: 'Sleep', unit: 'h', series: sleepSeries, color: 'var(--sleep)', good: 'up' },
  resp: { label: 'Breathing', unit: '/min', series: () => state.fitbit.metrics?.resp, color: 'var(--z-t)', good: 'down' },
  spo2: { label: 'SpO₂', unit: '%', series: () => state.fitbit.metrics?.spo2, color: 'var(--z-easy)' },
  skinTemp: { label: 'Skin temp', unit: '°C', series: () => state.fitbit.metrics?.skinTemp, color: 'var(--z-i)' },
  steps: { label: 'Steps', unit: '', series: () => state.fitbit.metrics?.steps, color: 'var(--z-long)', good: 'up', fmt: (v) => Math.round(v).toLocaleString() },
  weight: { label: 'Weight', unit: 'kg', series: () => state.fitbit.metrics?.weight, color: 'var(--muted)' },
  strain7: { label: '7-day strain', unit: '', series: () => strainSeries(7), color: 'var(--strain)' },
  weekKm: { label: 'This week', unit: distUnit(), series: () => ({ [today()]: round1(toUnit(runKmBetween(state.runs, mondayOf(today()), today()))) }), color: 'var(--accent)' },
};
function strainSeries(days) {
  const out = {};
  for (let i = 0; i < 30; i++) {
    const d = addDays(today(), -i);
    let tot = 0;
    for (let j = 0; j < days; j++) tot += dayStrain(state, addDays(d, -j)).strain;
    out[d] = round1(tot / days);
  }
  return out;
}

function metricStat(key) {
  const def = METRIC_DEFS[key];
  const series = def?.series() || {};
  const dates = Object.keys(series).sort();
  if (!dates.length) return null;
  const last = series[dates.at(-1)];
  const { baseline } = latestVsBaseline(series);
  const diff = baseline != null ? last - baseline : null;
  const cls = diff == null || Math.abs(diff) < Math.abs(baseline) * 0.03 ? '' : (diff > 0) === (def.good === 'up') ? 'up' : def.good ? 'down' : '';
  return { def, series, last, diff, cls, val: def.fmt ? def.fmt(last) : last };
}

function metricTile(key) {
  const m = metricStat(key);
  const def = METRIC_DEFS[key];
  if (!def) return '';
  return `<div class="mtile" style="--mc:${def.color}"><div class="ml">${def.label}</div>
    <div class="mv">${m ? m.val : '–'}<small>${m ? ` ${def.unit}` : ''}</small></div>
    ${m?.diff != null ? `<div class="delta ${m.cls}">${m.diff > 0 ? '▲' : '▼'} ${Math.abs(round1(m.diff))}</div>` : '<div class="delta">&nbsp;</div>'}
    ${m ? sparkline(m.series, def.color) : ''}</div>`;
}

function strainGauge(planned, current, target) {
  const pos = (v) => `${(clamp(v, 0, 21) / 21) * 100}%`;
  return `<div class="gauge">
    ${target ? `<span class="band" style="left:${pos(target[0])};width:calc(${pos(target[1])} - ${pos(target[0])})"></span>` : ''}
    <span class="fill" style="width:${pos(current)}"></span>
    ${planned ? `<span class="mark" style="left:${pos(planned)}" title="planned"></span>` : ''}
  </div><div class="gscale"><span>0</span><span>7</span><span>14</span><span>21</span></div>`;
}

// ---------------- views ----------------
function viewToday() {
  const t = today();
  const p = currentPaces(state);
  const pr = state.profile;
  const dtr = daysBetween(t, pr.raceDate);
  const ws = allWorkouts(state.plan);
  const todays = ws.filter((w) => w.date === t);
  const upcoming = ws.filter((w) => w.date > t).slice(0, 3);
  const wk = weekOf(state.plan, t);
  const rd = readiness(state);
  const st = dayStrain(state, t);
  const sl = sleepPerf(state, t);
  const ins = insights(state).slice(0, 3);
  const plannedRun = todays.find((w) => w.kind === 'run' && !statusOf(w));
  const planned = round1(sum(todays.filter((w) => !statusOf(w)), (w) => plannedStrain(w, p)));
  const target = targetStrain(rd?.score);
  const tiles = (state.settings.tiles || DEFAULT_TILES).filter((k) => METRIC_DEFS[k]);

  let weekStrip = '';
  if (wk) {
    const doneKm = runKmBetween(state.runs, wk.start, addDays(wk.start, 6));
    weekStrip = `<section class="card">
      <div class="row between"><h3>This week</h3><span class="muted">${fmtKm(toUnit(doneKm))} / ${fmtD(wk.plannedKm)}</span></div>
      <div class="bar"><span style="width:${Math.min(100, (doneKm / Math.max(1, wk.plannedKm)) * 100)}%"></span></div>
      <div class="strip">${[0, 1, 2, 3, 4, 5, 6].map((d) => {
        const date = addDays(wk.start, d);
        const dw = wk.workouts.filter((w) => w.date === date);
        return `<div class="sd ${date === t ? 'today' : ''}"><span>${DOW[d][0]}</span>${dw.map((w) => `<i class="dot ${statusOf(w) || (date < t ? 'missed' : '')}" style="--c:${TYPE_COLOR[w.type]}"></i>`).join('') || '<i class="dot rest"></i>'}</div>`;
      }).join('')}</div></section>`;
  }

  const starts = state.plan.start > t ? `<section class="card hero-sub">${icon('calendar')} Your plan starts <b>${fmtDate(state.plan.start)}</b>. Until then, keep running easy 3–4× a week and get a couple of strength sessions in.</section>` : '';
  const recSub = rd ? rd.label : google.signedIn(state) ? 'Connect Fitbit' : 'Sign in + Fitbit';

  return `<header class="top">
      <div><div class="eyebrow">${fmtDate(t, { weekday: 'long', day: 'numeric', month: 'long' })}</div><h1>${pr.name ? esc(pr.name) : 'Today'}</h1></div>
      <div class="countdown"><b>${dtr}</b><span>days to<br>${DISTANCES[pr.goal].label.replace(' marathon', '')}</span></div>
    </header>
    <section class="rings">
      ${ring(rd ? rd.score / 100 : 0, recoveryColor(rd?.score), rd ? `${rd.score}<small>%</small>` : '–', 'Recovery', recSub, rd ? 'openRecovery' : 'tab" data-tab="settings')}
      ${ring(st.strain / 21, 'var(--strain)', st.strain.toFixed(1), 'Strain', target ? `Target ${target[0]}–${target[1]}` : `Planned ${planned}`, 'openStrain')}
      ${ring(sl ? sl.pct / 100 : 0, 'var(--sleep)', sl ? `${sl.pct}<small>%</small>` : '–', 'Sleep', sl ? `${Math.floor(sl.min / 60)}h ${sl.min % 60}m` : 'No data', 'openSleep')}
    </section>
    ${starts}
    <section class="card coachline">
      <div class="row between"><b>${rd ? (rd.score >= 67 ? 'Green light. Go after it today.' : rd.score >= 34 ? 'Moderate recovery. Train, but don’t force it.' : 'Low recovery. Keep today easy.') : 'Today’s strain'}</b><span class="muted small">${st.strain.toFixed(1)} / 21</span></div>
      ${strainGauge(planned, st.strain, target)}
      <div class="muted small">${plannedRun ? `Today’s ${esc(plannedRun.title.toLowerCase())} should add ~${plannedStrain(plannedRun, p)} strain.` : 'No run planned today.'}${target ? ` Recommended for your recovery: ${target[0]}–${target[1]}.` : ''}</div>
      ${rd && rd.score < 34 && plannedRun && !['easy', 'long', 'race'].includes(plannedRun.type) ? `<button class="btn sm primary" data-act="swapEasy" data-id="${plannedRun.id}">Swap to easy</button>` : ''}
    </section>
    <h2 class="sec">Today</h2>
    ${todays.length ? todays.map((w) => workoutCard(w, p, { cta: true })).join('') : `<div class="wcard rest"><div class="grow"><div class="wtitle">Rest day</div><div class="muted">Recovery is where the adaptation happens. A walk or 10 minutes of mobility is plenty.</div></div></div>`}
    <button class="btn ghost block" data-act="startRun" data-id="">${icon('play')} Start a free run</button>
    <div class="row between"><h2 class="sec">Health monitor</h2><button class="btn sm ghost" data-act="editTiles">Customise</button></div>
    <div class="tiles">${tiles.map(metricTile).join('')}</div>
    ${ins.length ? `<h2 class="sec">Coach</h2>${ins.map(insightCard).join('')}` : ''}
    ${weekStrip}
    ${upcoming.length ? `<h2 class="sec">Up next</h2>${upcoming.map((w) => workoutCard(w, p, { showDate: true })).join('')}` : ''}`;
}

function viewPlan() {
  const t = today();
  const p = currentPaces(state);
  const pl = state.plan;
  const phaseColors = { base: 'var(--z-easy)', build: 'var(--z-t)', peak: 'var(--z-i)', taper: 'var(--z-m)' };
  const cur = weekOf(pl, t)?.index ?? 1;
  return `<header class="top"><div><div class="eyebrow">${DISTANCES[pl.goal].label} · ${fmtDate(pl.raceDate, { day: 'numeric', month: 'short', year: 'numeric' })}</div><h1>Your plan</h1></div></header>
    <div class="phasebar">${pl.weeks.map((w) => `<span title="Week ${w.index}" class="${w.index === cur ? 'cur' : ''}" style="background:${phaseColors[w.phase]};opacity:${w.cutback ? 0.55 : 1}"></span>`).join('')}</div>
    <div class="legend">${Object.entries(phaseColors).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('')}</div>
    ${pl.weeks.map((w) => {
      const open = w.index === cur || w.index === cur + 1;
      const done = runKmBetween(state.runs, w.start, addDays(w.start, 6));
      return `<details class="week" ${open ? 'open' : ''}>
        <summary><div><b>Week ${w.index}</b> <span class="chip" style="--c:${phaseColors[w.phase]}">${w.phase}${w.cutback ? ' · recovery' : ''}</span><div class="muted small">${fmtDate(w.start, { day: 'numeric', month: 'short' })} – ${fmtDate(addDays(w.start, 6), { day: 'numeric', month: 'short' })}</div></div>
        <div class="wkkm"><b>${fmtKm(toUnit(w.plannedKm))}</b> ${distUnit()}${w.start <= t ? `<div class="muted small">${fmtKm(toUnit(done))} done</div>` : ''}</div></summary>
        ${w.workouts.map((x) => workoutCard(x, p, { showDate: true })).join('') || '<p class="muted">No sessions this week.</p>'}
      </details>`;
    }).join('')}`;
}

function viewGym() {
  const t = today();
  const ws = allWorkouts(state.plan).filter((w) => w.kind === 'gym');
  const next = ws.find((w) => w.date >= t && !statusOf(w));
  const p = currentPaces(state);
  const logs = [...state.gymLogs].reverse().slice(0, 8);
  return `<header class="top"><div><div class="eyebrow">Strength for runners</div><h1>Gym</h1></div></header>
    ${next ? `<h2 class="sec">${next.date === t ? 'Today' : 'Next session'}</h2>${workoutCard(next, p, { showDate: next.date !== t, cta: true })}` : '<p class="muted">No gym sessions scheduled. Add gym days in Settings → Edit plan.</p>'}
    <section class="card"><h3>Why strength?</h3><p class="muted small">Heavy, low-rep lifting and plyometrics improve running economy by 2–8% and make tendons more resilient. The plan periodises with your running: capacity in base, heavy + explosive in build, maintenance in peak, mobility only in taper.</p></section>
    <h2 class="sec">Session library</h2>
    <div class="grid2">${allSessions().map((s) => `<button class="tile" data-act="openGymSession" data-key="${s.sessionKey}"><span class="chip">${s.phase}</span><b>${esc(s.title)}</b></button>`).join('')}</div>
    <h2 class="sec">History</h2>
    ${logs.length ? logs.map((l) => {
      const vol = sum(l.entries, (e) => sum(e.sets.filter((s) => s.done), (s) => (s.kg || 0) * (s.reps || 0)));
      const sets = sum(l.entries, (e) => e.sets.filter((s) => s.done).length);
      return `<div class="hist"><div class="grow"><b>${esc(l.title)}</b><div class="muted small">${fmtDate(l.date)} · ${sets} sets${vol ? ` · ${Math.round(vol).toLocaleString()} kg volume` : ''}</div></div><button class="x" data-act="deleteGym" data-id="${l.id}" aria-label="Delete">×</button></div>`;
    }).join('') : '<p class="muted">Logged sessions appear here.</p>'}`;
}

function weeklyChart() {
  const t = today();
  const start = addDays(mondayOf(t), -7 * 9);
  const weeks = Array.from({ length: 14 }, (_, i) => addDays(start, i * 7));
  const data = weeks.map((ws) => ({
    ws, actual: ws <= t ? toUnit(runKmBetween(state.runs, ws, addDays(ws, 6))) : null,
    planned: toUnit(weekOf(state.plan, ws)?.plannedKm ?? 0), cur: ws === mondayOf(t),
  }));
  const max = Math.max(10, ...data.map((d) => Math.max(d.actual || 0, d.planned)));
  const W = 340, H = 150, bw = W / data.length;
  const y = (v) => H - 18 - (v / max) * (H - 30);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Weekly kilometres, actual versus planned">
    ${[0.5, 1].map((f) => `<line x1="0" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" class="grid"/><text x="2" y="${y(max * f) - 3}" class="axis">${Math.round(max * f)}</text>`).join('')}
    ${data.map((d, i) => `
      ${d.planned ? `<rect x="${i * bw + 4}" y="${y(d.planned)}" width="${bw - 8}" height="${H - 18 - y(d.planned)}" rx="4" class="planned"/>` : ''}
      ${d.actual ? `<rect x="${i * bw + 7}" y="${y(d.actual)}" width="${bw - 14}" height="${H - 18 - y(d.actual)}" rx="3" class="actual"/>` : ''}
      <text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" class="axis ${d.cur ? 'cur' : ''}">${fmtDate(d.ws, { day: 'numeric' })}</text>`).join('')}
  </svg><div class="legend"><span><i class="lg-actual"></i>actual</span><span><i class="lg-planned"></i>planned</span></div>`;
}

function sparkline(series, color) {
  const t = today();
  const pts = Array.from({ length: 30 }, (_, i) => [i, series?.[addDays(t, i - 29)]]).filter(([, v]) => v != null);
  if (pts.length < 2) return '';
  const vs = pts.map(([, v]) => v), pad = (Math.max(...vs) - Math.min(...vs)) * 0.15 || 1;
  const lo = Math.min(...vs) - pad, hi = Math.max(...vs) + pad, W = 120, H = 34;
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / 29) * W).toFixed(1)},${(H - ((v - lo) / (hi - lo)) * H).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 -2 ${W} ${H + 4}" class="spark"><path d="${d}" style="stroke:${color}"/></svg>`;
}

// 14 days of Recovery (dots) vs Strain (bars), WHOOP-style.
function trendChart(days = 14) {
  const data = Array.from({ length: days }, (_, i) => {
    const d = addDays(today(), i - days + 1);
    return { d, rec: readiness(state, d)?.score ?? null, strain: dayStrain(state, d).strain, sleep: sleepPerf(state, d)?.pct ?? null };
  });
  const W = 340, H = 150, bw = W / days, base = H - 18;
  const yS = (v) => base - (v / 21) * (base - 10), yR = (v) => base - (v / 100) * (base - 10);
  const recPts = data.map((x, i) => (x.rec != null ? [i * bw + bw / 2, yR(x.rec), x.rec] : null)).filter(Boolean);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Recovery and strain, last ${days} days">
    ${data.map((x, i) => `<rect x="${i * bw + bw * 0.22}" y="${yS(x.strain)}" width="${bw * 0.56}" height="${base - yS(x.strain)}" rx="3" class="sbar"/>
      <text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" class="axis ${x.d === today() ? 'cur' : ''}">${fmtDate(x.d, { weekday: 'narrow' })}</text>`).join('')}
    ${recPts.length > 1 ? `<path d="${recPts.map(([x, y], k) => `${k ? 'L' : 'M'}${x},${y}`).join('')}" class="recline"/>` : ''}
    ${recPts.map(([x, y, v]) => `<circle cx="${x}" cy="${y}" r="4.5" style="fill:${recoveryColor(v)}"/>`).join('')}
  </svg><div class="legend"><span><i style="background:var(--strain)"></i>strain (0–21)</span><span><i style="background:var(--rec-green);border-radius:50%"></i>recovery %</span></div>`;
}

function healthCard() {
  const rows = Object.keys(METRIC_DEFS).map((k) => [k, metricStat(k)]).filter(([, m]) => m && Object.keys(m.series).length > 1);
  if (!rows.length) return '';
  return `<section class="card"><h3>Health trends</h3>
    ${rows.map(([k, m]) => `<div class="hm"><div class="grow"><div class="muted small">${m.def.label}</div>
        <b>${m.val}<small> ${m.def.unit}</small></b>
        ${m.diff != null ? `<span class="delta ${m.cls}">${m.diff > 0 ? '▲' : '▼'} ${Math.abs(round1(m.diff))} vs 2-wk avg</span>` : ''}</div>
        ${sparkline(m.series, m.def.color)}</div>`).join('')}
    <p class="muted small">Last 30 days. Low HRV, a rising resting HR or higher skin temperature lowers your recovery.</p></section>`;
}

function viewProgress() {
  const p = currentPaces(state);
  const pr = state.profile;
  const fit = fitnessEstimate(state);
  const runs = [...state.runs].reverse().slice(0, 25);
  const ins = insights(state);
  return `<header class="top"><div><div class="eyebrow">Fitness & insights</div><h1>Progress</h1></div></header>
    <section class="card fitness">
      <div class="row between"><div><div class="eyebrow">Fitness score (VDOT)</div><div class="big">${pr.vdot}</div></div>
      <button class="btn sm" data-act="editVdot">Adjust</button></div>
      ${fit ? `<p class="muted small">Best recent effort implies ~${fit.vdot}.</p>` : ''}
      <div class="preds">${Object.entries(DISTANCES).map(([k, d]) => `<div class="${k === pr.goal ? 'goal' : ''}"><span>${d.label.replace('Half marathon', 'Half')}</span><b>${fmtDur(predictTime(pr.vdot, d.m))}</b></div>`).join('')}</div>
    </section>
    <section class="card"><h3>Your training paces</h3>
      ${['E', 'M', 'T', 'I', 'R'].map((z) => `<div class="step"><span class="zdot" style="background:${ZONES[z].color}"></span><div class="grow"><b>${ZONES[z].name}</b><div class="muted small">${ZONES[z].desc}</div></div><div class="pace">${paceRange(z, p)}<small>${paceUnit()}</small></div></div>`).join('')}
    </section>
    <section class="card"><h3>Recovery vs strain</h3>${trendChart()}</section>
    <section class="card"><h3>Weekly distance <span class="muted small">(${distUnit()})</span></h3>${weeklyChart()}</section>
    ${healthCard()}
    <h2 class="sec">Coach insights</h2>
    ${ins.length ? ins.map(insightCard).join('') : '<p class="muted">Log a few runs and the coach starts adapting your plan.</p>'}
    <div class="row between"><h2 class="sec">Runs</h2><button class="btn sm" data-act="logRun" data-id="">+ Log run</button></div>
    ${runs.length ? runs.map((r) => {
      const w = r.workoutId && workoutById(state, r.workoutId);
      return `<div class="hist tap" data-act="openRun" data-id="${r.id}">${routeSvg(r, { w: 54, h: 40, cls: 'route thumb' }) || `<span class="zdot" style="background:${TYPE_COLOR[w?.type] || 'var(--muted)'}"></span>`}<div class="grow"><b>${esc(w?.title || r.name || 'Run')}${r.stravaId ? ' <span class="chip strava">Strava</span>' : ''}${r.songs?.length ? ` <span class="chip spot">♫ ${r.songs.length}</span>` : ''}</b>
        <div class="muted small">${fmtDate(r.date)} · ${fmtD(r.distKm)} · ${fmtDur(r.durSec)} · ${fmtP(r.durSec / r.distKm)}${paceUnit()}${r.avgHr ? ` · ${r.avgHr}${r.maxHr ? `/${r.maxHr}` : ''} bpm` : ''} · ${r.source}</div></div>
        <button class="x" data-act="deleteRun" data-id="${r.id}" aria-label="Delete run">×</button></div>`;
    }).join('') : '<p class="muted">No runs yet.</p>'}`;
}

function syncLabel() {
  const a = state.auth;
  if (!a?.syncedAt) return 'Not synced yet';
  const min = Math.round((Date.now() - a.syncedAt) / 60000);
  return `Synced ${min < 1 ? 'just now' : min < 60 ? `${min} min ago` : new Date(a.syncedAt).toLocaleString()}`;
}

function accountCard() {
  if (!google.signedIn(state)) {
    return `<section class="card signin"><h3>Account</h3>
      <p class="muted small">Sign in with Google to stay logged in and sync your plan, runs, gym logs and Fitbit data across all your devices. Data is saved in a hidden Stride folder in your own Google Drive.</p>
      <button class="btn gsi block" data-act="signIn">${GOOGLE_G} Sign in with Google</button></section>`;
  }
  const a = state.auth;
  return `<section class="card"><div class="account">${avatar()}<div class="grow"><b>${esc(a.name || a.email)}</b><div class="muted small">${esc(a.email)}</div>
      <div class="muted small">${a.needsTap ? '<span class="warnt">Session paused, tap Reconnect</span>' : esc(syncLabel())}</div>
      ${state.profile ? `<div class="muted small">Plan: ${DISTANCES[state.profile.goal].label} ${fmtDate(state.profile.raceDate, { day: 'numeric', month: 'short' })} · saved ${state.planAt ? new Date(state.planAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'before sync'}</div>` : ''}</div></div>
    <div class="row gap">
      ${a.needsTap || !google.hasToken(state) ? `<button class="btn primary" data-act="signIn">Reconnect</button>` : `<button class="btn" data-act="syncCloud">${icon('sync')} Sync now</button>`}
      <button class="btn ghost" data-act="signOut">Sign out</button>
    </div>
    <div class="row gap">
      ${state.profile && google.hasToken(state) ? '<button class="btn sm ghost" data-act="usePlanHere">Use this device’s plan everywhere</button>' : ''}
    </div>
    ${state.syncError ? `<div class="err">${esc(state.syncError)}</div>` : ''}</section>`;
}

function prefsCard() {
  const u = state.settings.units;
  return `<section class="card"><h3>Units & dashboard</h3>
    <div class="seg"><button class="${u !== 'mi' ? 'on' : ''}" data-act="setUnits" data-u="km">Kilometres</button><button class="${u === 'mi' ? 'on' : ''}" data-act="setUnits" data-u="mi">Miles</button></div>
    <button class="btn block" data-act="editTiles">Choose health-monitor metrics</button></section>`;
}

function voiceCard() {
  const v = { ...DEFAULT_VOICE, ...state.settings.voice };
  const tg = (k, label) => `<label class="check"><input type="checkbox" data-voice="${k}" ${v[k] ? 'checked' : ''}> ${label}</label>`;
  return `<section class="card"><h3>Voice coach</h3>
    <p class="muted small">Spoken cues during guided runs, over your music. You can also tap the stats on the run screen at any time to hear distance, time and pace.</p>
    ${tg('on', 'Voice cues on')}
    <label>Announce every<select data-voice="every">${[0.5, 1, 2, 5].map((n) => `<option value="${n}" ${+v.every === n ? 'selected' : ''}>${n} ${distUnit()}</option>`).join('')}</select></label>
    ${tg('time', 'Total time')}${tg('pace', 'Split pace')}${tg('avgPace', 'Average pace')}
    ${tg('alerts', 'Pace alerts when you drift off target')}${tg('countdown', 'Countdowns at the end of reps')}
    <button class="btn sm" data-act="testVoice">Test voice</button></section>`;
}

function stravaCard() {
  const c = strava.cfg(state);
  if (strava.connected(state)) {
    const pending = state.runs.filter((r) => r.source === 'gps' && !r.stravaId).length;
    return `<section class="card"><h3><span class="brand-dot strava"></span>Strava</h3>
      <p class="muted small">Connected${c.athlete?.name ? ` as ${esc(c.athlete.name)}` : ''}. Imports your runs and map outlines${c.autoPush ? ', and uploads runs you record in Stride' : ''}.${c.lastSync ? ` Last sync ${new Date(c.lastSync).toLocaleTimeString()}.` : ''}</p>
      <label class="check"><input type="checkbox" data-act-change="stravaAuto" ${c.autoPush ? 'checked' : ''}> Auto-upload Stride GPS runs</label>
      ${pending ? `<p class="muted small">${pending} Stride run(s) not on Strava yet.</p>` : ''}
      <div class="row gap"><button class="btn primary" data-act="stravaSync">${icon('sync')} Sync Strava</button><button class="btn ghost" data-act="stravaDisconnect">Disconnect</button></div>
      ${c.error ? `<div class="err">${esc(c.error)}</div>` : ''}</section>`;
  }
  return `<section class="card"><h3><span class="brand-dot strava"></span>Strava</h3>
    <p class="muted small">Push your runs to Strava and pull map outlines. One-time setup: create an API app at <b>strava.com/settings/api</b> with Authorization Callback Domain <code>${esc(location.hostname)}</code>, then paste its Client ID and Client Secret here. They’re stored only on your devices and in your private Drive sync.</p>
    <div class="row2"><label>Client ID<input id="stravaId" value="${esc(c.clientId || '')}" inputmode="numeric"></label>
    <label>Client Secret<input id="stravaSecret" type="password" value="${esc(c.clientSecret || '')}" autocapitalize="off"></label></div>
    <button class="btn primary block strava-btn" data-act="stravaConnect">Connect with Strava</button>
    ${c.error ? `<div class="err">${esc(c.error)}</div>` : ''}</section>`;
}

function spotifyCard() {
  const id = spotify.clientIdOf(state);
  if (spotify.connected()) {
    return `<section class="card"><h3><span class="brand-dot spot"></span>Spotify</h3>
      <p class="muted small">Connected. Shows what’s playing during runs and saves the songs you listened to with each run.</p>
      <button class="btn ghost" data-act="spotifyDisconnect">Disconnect</button></section>`;
  }
  return `<section class="card"><h3><span class="brand-dot spot"></span>Spotify</h3>
    <p class="muted small">See the songs from each run. One-time setup: create an app at <b>developer.spotify.com/dashboard</b> (Web API), add redirect URI <code>${esc(google.redirectUri())}</code>, add your Spotify email under <b>User Management</b>, then paste the Client ID here.</p>
    <label>Client ID<input id="spotifyId" value="${esc(id)}" autocapitalize="off" spellcheck="false"></label>
    <button class="btn block spot-btn" data-act="spotifyConnect">Connect Spotify</button></section>`;
}

function viewSettings() {
  const fb = state.fitbit;
  const pr = state.profile;
  const connected = google.healthOk(state);
  const wanted = state.auth?.healthWanted;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `<header class="top"><div><div class="eyebrow">Stride</div><h1>Settings</h1></div></header>
    ${!standalone ? `<section class="card hero-sub">${icon('share')} <div><b>Install on your iPhone</b><div class="muted small">In Safari tap Share → <b>Add to Home Screen</b>. It then opens full-screen like a native app. Sign in from inside the installed app, because iOS keeps its storage separate from Safari.</div></div></section>` : ''}
    ${accountCard()}
    <section class="card">
      <h3>Plan</h3>
      <p class="muted small">${DISTANCES[pr.goal].label} on ${fmtDate(pr.raceDate, { day: 'numeric', month: 'long', year: 'numeric' })} · ${pr.runDays.length} runs/week · ${pr.gymDays.length} gym/week · volume ×${pr.volumeScale ?? 1}</p>
      <button class="btn block" data-act="editProfile">Edit profile & rebuild plan</button>
    </section>
    ${prefsCard()}
    ${voiceCard()}
    ${stravaCard()}
    ${spotifyCard()}
    <section class="card">
      <h3>Fitbit via Google Health</h3>
      <p class="muted small">Pulls runs (distance, time, avg/max heart rate, calories), VO₂ max, HRV, resting heart rate, sleep, SpO₂, breathing rate, skin temperature, steps and weight from your Fitbit through Google’s Health API.</p>
      <div class="row gap">
        ${!google.signedIn(state) ? '<span class="muted small">Sign in with Google first.</span>'
          : connected ? `<button class="btn primary" data-act="fbSync">${icon('sync')} Sync Fitbit now</button>`
          : `<button class="btn primary" data-act="fbConnect">${wanted ? 'Reconnect Fitbit' : 'Connect Fitbit'}</button>`}
      </div>
      ${fb.lastSync ? `<div class="muted small">Data received: ${['Runs', Object.keys(fb.rhr).length && 'Resting HR', Object.keys(fb.sleep).length && 'Sleep', ...Object.entries(fb.metrics || {}).filter(([, v]) => Object.keys(v).length).map(([k]) => health.METRICS[k]?.label)].filter(Boolean).join(' · ')}</div>` : ''}
      <div class="muted small">${fb.lastSync ? `Last Fitbit sync ${new Date(fb.lastSync).toLocaleString()}` : 'Never synced'}</div>
      ${fb.tokenScopes != null ? `<div class="muted small">Fitbit token permissions: <code>${esc(fb.tokenScopes || 'none')}</code></div>` : ''}
      ${fb.error && /disallowed/i.test(fb.error) ? '<button class="btn sm" data-act="fbConnect">Re-grant Fitbit permission</button>' : ''}
      ${fb.error ? `<div class="err">${esc(fb.error)}</div>` : ''}
      ${fb.lastRaw ? `<details><summary class="small">Show last raw response</summary><pre>${esc(JSON.stringify(fb.lastRaw, null, 1).slice(0, 3000))}</pre></details>` : ''}
    </section>
    <details class="card"><summary class="small muted">Google setup (advanced)</summary>
      <label>Google OAuth Client ID<input id="clientId" value="${esc(google.clientId())}" placeholder="1234-abc.apps.googleusercontent.com" autocapitalize="off" spellcheck="false"></label>
      <button class="btn sm" data-act="saveClientId">Save</button>
      <div class="muted small">Authorised redirect URI: <code>${esc(google.redirectUri())}</code></div>
    </details>
    <section class="card">
      <h3>Import runs</h3>
      <p class="muted small">GPX or TCX files from any watch or app, or files from your Fitbit / Google Takeout export: <code>exercise-*.json</code>, <code>demographic_vo2_max-*.json</code>, <code>resting_heart_rate-*.json</code>, <code>sleep-*.json</code>, <code>weight-*.json</code>. Runs on a planned day are matched to the plan automatically.</p>
      <label class="btn block file">Choose files<input type="file" id="importFiles" multiple accept=".gpx,.tcx,.json,application/json,application/gpx+xml"></label>
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="muted small">Everything is stored on this device only. Export a backup to move between Safari and the home-screen app, or to a new phone.</p>
      <div class="row gap"><button class="btn" data-act="exportData">Export</button><label class="btn file">Import<input type="file" id="importBackup" accept=".json,application/json"></label></div>
    </section>
    <section class="card"><button class="btn block danger" data-act="reset">Reset everything</button></section>
    <p class="muted small center">Stride v${APP_VERSION}. Stride gives training guidance, not medical advice. Stop and get checked if something hurts.</p>`;
}

function render() {
  if (!state.profile || !state.plan || editingProfile) { $('#tabs').hidden = true; return renderOnboarding(); }
  $('#tabs').hidden = false;
  const views = { today: viewToday, plan: viewPlan, gym: viewGym, progress: viewProgress, settings: viewSettings };
  app.innerHTML = `<div class="view">${(views[tab] || viewToday)()}${FOOTER}</div>`;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}

// ---------------- sheets ----------------
function openWorkout(id) {
  const w = workoutById(state, id);
  if (!w) return;
  const p = currentPaces(state);
  const st = statusOf(w);
  const run = runFor(w);
  const isPastOrToday = w.date <= today();
  openSheet(`
    <div class="eyebrow">${fmtDate(w.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${w.phase}</div>
    <h2 style="--c:${TYPE_COLOR[w.type]}" class="stitle">${esc(w.title)}</h2>
    <p class="lead">${esc(uText(w.summary))}</p>
    <div class="stats3"><div><b>${fmtKm(toUnit(w.km))}</b><span>${distUnit()}</span></div><div><b>${fmtDur(estSec(w, p))}</b><span>est. time</span></div><div><b>${w.steps.length}</b><span>steps</span></div></div>
    <div class="steps">${stepsHtml(w, p)}</div>
    <div class="why"><b>Why this session</b><p>${esc(w.purpose)}</p></div>
    ${run ? `<div class="card done-card">${icon('check')} Completed: ${fmtD(run.distKm)} in ${fmtDur(run.durSec)} (${fmtP(run.durSec / run.distKm)}${paceUnit()})${run.avgHr ? `, ${run.avgHr} bpm` : ''}</div>` : ''}
    <div class="actions">
      ${!st ? `<button class="btn primary block" data-act="startRun" data-id="${w.id}">${icon('play')} Start guided run</button>
        <div class="row gap"><button class="btn grow" data-act="logRun" data-id="${w.id}">Log manually</button>
        ${w.type !== 'easy' && w.type !== 'race' ? `<button class="btn grow" data-act="swapEasy" data-id="${w.id}">Swap to easy</button>` : ''}
        ${isPastOrToday ? `<button class="btn grow ghost" data-act="skip" data-id="${w.id}">Skip</button>` : ''}</div>`
      : `<button class="btn block ghost" data-act="unmark" data-id="${w.id}">${st === 'done' ? 'Unlink run' : 'Undo skip'}</button>`}
    </div>`);
}

function openLogRun(id) {
  const w = id ? workoutById(state, id) : null;
  openSheet(`<h2>Log a run</h2>
    <form id="logForm">
      <div class="row2"><label>Date<input type="date" name="date" value="${w?.date || today()}" max="${today()}"></label>
      <label>Distance (${distUnit()})<input type="number" step="0.01" name="km" required value="${w ? round1(toUnit(w.km)) : ''}" inputmode="decimal"></label></div>
      <div class="row2"><label>Time (h:mm:ss)<input name="time" required placeholder="45:00" inputmode="numeric"></label>
      <label>Avg HR <span class="muted">(opt.)</span><input type="number" name="hr" inputmode="numeric"></label></div>
      <label>Effort (RPE): <output id="rpeOut">5</output>/10<input type="range" name="rpe" min="1" max="10" value="5" oninput="rpeOut.value=this.value"></label>
      <label class="check"><input type="checkbox" name="isRace"> This was a race or all-out time trial</label>
      <button class="btn primary block">Save run</button>
    </form>`);
  $('#logForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const durSec = parseDur(f.get('time'));
    const distKm = Number(f.get('km')) * (isMi() ? KM_PER_MI : 1);
    if (!(durSec > 0) || !(distKm > 0)) return toast('Enter distance and time');
    const run = { id: uid(), at: Date.now(), source: 'manual', name: w?.title || 'Run', date: f.get('date'), distKm: Math.round(distKm * 100) / 100, durSec, avgHr: Number(f.get('hr')) || null, rpe: Number(f.get('rpe')), isRace: !!f.get('isRace') };
    addRun(run, w?.date === run.date ? w : null);
    closeSheet();
    toast(`Saved ${fmtD(distKm)} at ${fmtP(durSec / distKm)}${paceUnit()}`);
  });
}

function addRun(run, workout) {
  if (workout) { run.workoutId = workout.id; state.completions[workout.id] = { status: 'done', runId: run.id, at: Date.now() }; }
  else matchRun(state, run);
  state.runs.push(run);
  state.runs.sort((a, b) => a.date.localeCompare(b.date));
  save();
  render();
}

function openGym(workout, sessionKey) {
  const sess = workout ? workout : sessionByKey(sessionKey);
  if (!sess) return;
  const prev = workout && state.gymLogs.find((l) => l.id === state.completions[workout.id]?.logId);
  openSheet(`
    <div class="eyebrow">${workout ? fmtDate(workout.date, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Library session'}</div>
    <h2 class="stitle" style="--c:var(--gym)">${esc(sess.title)}</h2>
    ${workout?.sessionKey?.startsWith('mobility') && workout.phase !== 'taper' ? '<p class="muted small">Light session: key run tomorrow.</p>' : ''}
    <form id="gymForm">
    ${sess.items.map((it, k) => {
      const ex = EXERCISES[it.ex];
      const sug = suggestLoad(state.gymLogs, it.ex, it.reps);
      const prevE = prev?.entries.find((e) => e.ex === it.ex);
      return `<div class="ex">
        <div class="row between"><b>${esc(ex.name)}</b><span class="chip">${it.sets} × ${it.reps}${ex.unit === 's' ? ' s' : ''}</span></div>
        <div class="muted small">${esc(ex.cue)} Rest ${it.rest}s.</div>
        ${sug ? `<div class="sug small">${icon('spark')} ${sug.kg} kg: ${esc(sug.why)}</div>` : ''}
        <div class="sets">${Array.from({ length: it.sets }, (_, si) => {
          const ps = prevE?.sets[si];
          return `<div class="set"><span class="muted">${si + 1}</span>
          ${ex.bodyweight ? '<span class="muted small grow">bodyweight</span>' : `<input type="number" step="0.5" inputmode="decimal" name="kg-${k}-${si}" placeholder="kg" value="${ps?.kg ?? sug?.kg ?? ''}">`}
          <input type="number" inputmode="numeric" name="reps-${k}-${si}" value="${ps?.reps ?? it.reps}">
          <label class="tick"><input type="checkbox" name="done-${k}-${si}" ${ps?.done ? 'checked' : ''}><span>${icon('check')}</span></label></div>`;
        }).join('')}</div></div>`;
    }).join('')}
    <button class="btn primary block">Save session</button></form>`);
  $('#gymForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const entries = sess.items.map((it, k) => ({
      ex: it.ex,
      sets: Array.from({ length: it.sets }, (_, si) => ({ kg: Number(f.get(`kg-${k}-${si}`)) || 0, reps: Number(f.get(`reps-${k}-${si}`)) || 0, done: !!f.get(`done-${k}-${si}`) })),
    }));
    if (!entries.some((en) => en.sets.some((s) => s.done))) return toast('Tick off the sets you completed');
    const log = { at: Date.now(), id: prev?.id || uid(), date: workout?.date || today(), workoutId: workout?.id, sessionKey: sess.sessionKey, title: sess.title, entries };
    state.gymLogs = state.gymLogs.filter((l) => l.id !== log.id);
    state.gymLogs.push(log);
    state.gymLogs.sort((a, b) => a.date.localeCompare(b.date));
    if (workout) state.completions[workout.id] = { status: 'done', logId: log.id, at: Date.now() };
    save(); closeSheet(); render();
    toast('Session saved 💪');
  });
}

// ---------------- run detail ----------------
function openRun(id) {
  const r = state.runs.find((x) => x.id === id);
  if (!r) return;
  const w = r.workoutId && workoutById(state, r.workoutId);
  const strain = round1(21 * (1 - Math.exp(-runLoad(state, r) / 110)));
  const map = routeSvg(r, { w: 340, h: 220, cls: 'route big' });
  openSheet(`
    <div class="eyebrow">${fmtDate(r.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${esc(r.source)}</div>
    <h2 class="stitle" style="--c:${TYPE_COLOR[w?.type] || 'var(--accent)'}">${esc(w?.title || r.name || 'Run')}</h2>
    ${map ? `<div class="mapbox">${map}</div>` : `<div class="mapbox empty muted small">${r.stravaId ? 'No GPS map on this activity' : 'No map yet. GPS runs and Strava-synced runs show their route here.'}</div>`}
    <div class="stats3">
      <div><b>${fmtKm(toUnit(r.distKm))}</b><span>${distUnit()}</span></div>
      <div><b>${fmtDur(r.durSec)}</b><span>time</span></div>
      <div><b>${fmtP(r.durSec / r.distKm)}</b><span>${paceUnit()}</span></div>
      <div><b>${r.avgHr || '–'}</b><span>avg bpm</span></div>
      <div><b>${r.maxHr || '–'}</b><span>max bpm</span></div>
      <div><b style="color:var(--strain)">${strain}</b><span>strain</span></div>
    </div>
    ${r.songs?.length ? `<h3>Soundtrack</h3><div class="songs">${r.songs.map((x) => `<a class="song" href="${esc(x.url || '#')}" target="_blank" rel="noopener">${x.img ? `<img src="${esc(x.img)}" alt="">` : '<span class="brand-dot spot"></span>'}<div class="grow"><b>${esc(x.name)}</b><div class="muted small">${esc(x.artist)}</div></div><span class="muted small">${new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></a>`).join('')}</div>`
      : spotify.connected() ? `<button class="btn block" data-act="findSongs" data-id="${r.id}">♫ Find songs from this run</button>` : ''}
    <div class="actions">
      ${r.stravaId ? `<a class="btn block strava-btn" href="${strava.activityUrl(r.stravaId)}" target="_blank" rel="noopener">View on Strava</a>`
        : strava.connected(state) ? `<button class="btn block strava-btn" data-act="pushStrava" data-id="${r.id}">Upload to Strava</button>` : ''}
      <button class="btn block ghost danger" data-act="deleteRun" data-id="${r.id}">Delete run</button>
    </div>`);
}

function runDescription(run) {
  const w = run.workoutId && workoutById(state, run.workoutId);
  const lines = [];
  if (w) lines.push(`${w.title}: ${w.summary}`);
  if (run.songs?.length) lines.push(`🎧 ${run.songs.slice(0, 8).map((x) => `${x.name} (${x.artist})`).join(', ')}`);
  lines.push('Recorded with Stride');
  return lines.join('\n');
}

async function attachSongs(run, quiet = true) {
  if (!spotify.connected() || run.songs?.length) return;
  try {
    const songs = await spotify.songsForRun(state, run);
    if (songs.length) { run.songs = songs; run.at = Date.now(); save(); render(); }
    else if (!quiet) toast('No Spotify plays found during this run (Spotify only keeps your last 50 plays)');
  } catch (e) { if (!quiet) toast(e.message); }
}

async function pushToStrava(run, quiet = false) {
  try {
    if (!quiet) toast('Uploading to Strava…', 1500);
    await strava.push(state, run, runDescription(run));
    strava.cfg(state).error = null;
    state.integrationsAt = Date.now();
    save(); render();
    toast('Uploaded to Strava');
  } catch (e) {
    strava.cfg(state).error = e.message; save(true);
    if (!quiet) toast(e.message);
  }
}

async function afterRunSaved(run) {
  await attachSongs(run);
  if (strava.connected(state) && strava.cfg(state).autoPush && run.source === 'gps') pushToStrava(run, true);
}

let stravaBusy = false;
async function stravaSync(quiet = false) {
  if (!strava.connected(state) || stravaBusy) return;
  stravaBusy = true;
  try {
    const fresh = [];
    const res = await strava.sync(state, (r) => { matchRun(state, r); fresh.push(r); });
    strava.cfg(state).error = null;
    state.integrationsAt = Date.now();
    save(); render();
    for (const r of fresh) if (Date.now() - Date.parse(r.startTime) < 36 * 3600e3) attachSongs(r);
    if (strava.cfg(state).autoPush) {
      const since = (strava.cfg(state).connectedAt || Date.now()) - 7 * 864e5; // don't back-fill your whole history
      for (const r of state.runs.filter((x) => x.source === 'gps' && !x.stravaId && !x.stravaFailed && (x.at || 0) >= since)) {
        await pushToStrava(r, true);
        if (!r.stravaId) r.stravaFailed = true;
      }
    }
    if (!quiet) toast(`Strava: ${res.added} new run(s), ${res.linked} map(s) linked`);
  } catch (e) {
    strava.cfg(state).error = e.message; save(true); render();
    if (!quiet) toast(e.message);
  } finally { stravaBusy = false; }
}

// Now playing during guided runs
let nowPlaying = null, npTimer = null;
function startNowPlaying() {
  if (!spotify.connected()) return;
  const poll = async () => { try { nowPlaying = await spotify.nowPlaying(state); renderTracker(); } catch { /* offline */ } };
  poll();
  npTimer = setInterval(poll, 20000);
}
function stopNowPlaying() { clearInterval(npTimer); npTimer = null; nowPlaying = null; }

// Recovery / strain / sleep detail sheets
function openRecovery() {
  const rd = readiness(state);
  if (!rd) return;
  openSheet(`<div class="eyebrow">Recovery</div><h2 style="color:${recoveryColor(rd.score)}">${rd.score}% · ${rd.label}</h2>
    <ul class="why-list">${rd.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    <p class="muted small">Recovery combines HRV vs your 2-week baseline (the biggest factor), resting heart rate, sleep, breathing rate, skin temperature and SpO₂ from Fitbit, plus your training load over the last 3 days. Green (67+) means push, yellow (34–66) means train normally, red means go easy.</p>
    <section class="card"><h3>Last 14 days</h3>${trendChart()}</section>`);
}
function openStrain() {
  const t = today();
  const st = dayStrain(state, t);
  const runsToday = state.runs.filter((r) => r.date === t);
  openSheet(`<div class="eyebrow">Strain</div><h2 style="color:var(--strain)">${st.strain.toFixed(1)} / 21</h2>
    ${runsToday.map((r) => `<div class="step"><div class="grow"><b>${esc(r.name || 'Run')}</b> <span class="muted">${fmtD(r.distKm)}</span></div><b>${round1(21 * (1 - Math.exp(-runLoad(state, r) / 110)))}</b></div>`).join('') || '<p class="muted">No activity logged today yet.</p>'}
    <p class="muted small">Strain measures cardiovascular load on a 0–21 scale. It comes from your heart rate relative to your resting and max HR (TRIMP), with perceived effort used when there’s no heart-rate data. The scale is logarithmic: going from 18 to 19 takes far more work than going from 8 to 9. Gym sessions count too.</p>`);
}
function openSleep() {
  const sl = sleepPerf(state);
  if (!sl) return toast('No sleep data yet. Connect Fitbit in Settings.');
  openSheet(`<div class="eyebrow">Sleep performance</div><h2 style="color:var(--sleep)">${sl.pct}%</h2>
    <p>${Math.floor(sl.min / 60)}h ${sl.min % 60}m asleep of a ${Math.floor(sl.need / 60)}h ${Math.round(sl.need % 60)}m need.</p>
    <p class="muted small">Your sleep need starts at 8 h and rises after high-strain days. Hitting 85%+ most nights is the best single thing you can do for recovery during marathon training.</p>`);
}

function openTileEditor() {
  const cur = state.settings.tiles || DEFAULT_TILES;
  openSheet(`<h2>Health monitor</h2><p class="muted small">Choose what shows on your Today screen.</p>
    <form id="tileForm">${Object.entries(METRIC_DEFS).map(([k, d]) => `<label class="check"><input type="checkbox" name="t" value="${k}" ${cur.includes(k) ? 'checked' : ''}> ${d.label}</label>`).join('')}
    <button class="btn primary block">Save</button></form>`);
  $('#tileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.settings.tiles = new FormData(e.target).getAll('t');
    state.settingsAt = Date.now();
    save(); closeSheet(); render();
  });
}

// ---------------- guided run ----------------
function startRun(id) {
  const w = id ? workoutById(state, id) : null;
  closeSheet();
  tracker = new RunTracker(w, currentPaces(state), renderTracker, { unit: state.settings.units, voice: state.settings.voice });
  startNowPlaying();
  trackerEl.hidden = false;
  document.body.classList.add('noscroll');
  renderTracker();
}

function renderTracker() {
  if (!tracker) return;
  const tr = tracker;
  const p = currentPaces(state);
  if (tr.state === 'ready') {
    trackerEl.innerHTML = `<div class="trk ready">
      <button class="x big" data-act="tDiscard" aria-label="Close">×</button>
      <div class="eyebrow">${tr.workout ? esc(tr.workout.title) : 'Free run'}</div>
      <h1>${tr.workout ? esc(uText(tr.workout.summary)) : 'Just run'}</h1>
      ${tr.workout ? `<div class="steps">${stepsHtml(tr.workout, p)}</div>` : ''}
      <p class="muted small">Keep the screen on and the app open. iOS pauses GPS for web apps when the phone is locked. The voice coach announces each step, every ${state.settings.voice?.every || 1} ${distUnit()}, countdowns and pace alerts. Tap the stats any time to hear them.</p>
      <button class="btn primary block xl" data-act="tStart">${icon('play')} Start</button></div>`;
    return;
  }
  const s = tr.step;
  const z = p[s.zone];
  const rem = tr.stepRemaining();
  const cp = tr.curPace;
  let fb = '';
  if (isFinite(cp) && s.zone !== 'Rec') fb = cp < z.lo - 3 ? '<span class="fb fast">Ease off</span>' : cp > z.hi + 3 ? '<span class="fb slow">Pick it up</span>' : '<span class="fb ok">On pace</span>';
  const nxt = tr.steps[tr.i + 1];
  trackerEl.innerHTML = `<div class="trk ${tr.state}">
    <div class="gps muted small">${esc(tr.gpsStatus)}</div>
    <div class="tstep" style="--c:${ZONES[s.zone].color}">
      <div class="row between"><b>${esc(s.label)}</b><span>${tr.i + 1}/${tr.steps.length}</span></div>
      <div class="target">${ZONES[s.zone].name} · ${fmtP(z.lo)}–${fmtP(z.hi)}${paceUnit()}</div>
      ${rem ? `<div class="remain">${rem.kind === 'dist' ? `${Math.round(rem.v)} m` : fmtDur(rem.v)}<small> left</small></div>` : ''}
      <div class="bar"><span style="width:${tr.stepProgress() * 100}%"></span></div>
    </div>
    <div class="tgrid" data-act="tStats" title="Tap to hear your stats">
      <div><b>${fmtDur(tr.elapsed / 1000)}</b><span>time</span></div>
      <div><b>${toUnit(tr.dist / 1000).toFixed(2)}</b><span>${distUnit()}</span></div>
      <div><b>${fmtP(cp)}</b><span>pace ${fb}</span></div>
      <div><b>${fmtP(tr.avgPace)}</b><span>avg pace</span></div>
    </div>
    <div class="muted small center">${icon('spark')} Tap stats to hear them</div>
    ${nowPlaying ? `<div class="nowp">${nowPlaying.img ? `<img src="${esc(nowPlaying.img)}" alt="">` : '<span class="brand-dot spot"></span>'}<div class="grow"><b>${esc(nowPlaying.name)}</b><div class="muted small">${esc(nowPlaying.artist)}</div></div></div>` : ''}
    ${nxt ? `<div class="next muted">Next: ${esc(nxt.label)} · ${nxt.dist || nxt.time ? stepAmount(nxt) : ''} ${ZONES[nxt.zone].name}</div>` : ''}
    <div class="tbtns">
      ${tr.state === 'running' ? `<button class="btn xl" data-act="tPause">${icon('pause')} Pause</button>` : `<button class="btn xl primary" data-act="tResume">${icon('play')} Resume</button>`}
      <button class="btn xl" data-act="tNext">Skip step</button>
      <button class="btn xl danger" data-act="tFinish">Finish</button>
    </div></div>`;
}

function finishRun() {
  stopNowPlaying();
  const run = tracker.finish();
  const w = tracker.workout;
  tracker = null;
  trackerEl.hidden = true;
  trackerEl.innerHTML = '';
  document.body.classList.remove('noscroll');
  if (run.distKm < 0.2) { toast('Run too short to save'); return; }
  openSheet(`<h2>Nice work!</h2>
    <div class="stats3"><div><b>${fmtKm(toUnit(run.distKm))}</b><span>${distUnit()}</span></div><div><b>${fmtDur(run.durSec)}</b><span>time</span></div><div><b>${fmtP(run.durSec / run.distKm)}</b><span>${paceUnit()}</span></div></div>
    <form id="saveRun"><label>How hard did it feel? <output id="rpe2">5</output>/10<input type="range" name="rpe" min="1" max="10" value="5" oninput="rpe2.value=this.value"></label>
    <label class="check"><input type="checkbox" name="isRace"> Race / time trial</label>
    <button class="btn primary block">Save run</button><button type="button" class="btn ghost block" data-act="closeSheet">Discard</button></form>`);
  $('#saveRun').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    run.rpe = Number(f.get('rpe'));
    run.isRace = !!f.get('isRace');
    delete run.workoutId;
    addRun(run, w && w.date === run.date ? w : null);
    closeSheet();
    toast('Run saved');
    afterRunSaved(run);
  });
}

// ---------------- actions ----------------
async function importFiles(files) {
  let added = 0, errors = 0, metrics = 0;
  for (const file of files) {
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const n = health.importFitbitDaily(file.name, JSON.parse(text), state.fitbit);
        if (n >= 0) { metrics += n; continue; }
      }
      const runs = file.name.toLowerCase().endsWith('.json') ? health.parseFitbitExport(JSON.parse(text)) : [health.parseTrackFile(text, file.name)];
      for (const r of runs) {
        if (r.extId && state.runs.some((x) => x.extId === r.extId)) continue;
        if (state.runs.some((x) => x.startTime && x.startTime === r.startTime)) continue;
        matchRun(state, r); state.runs.push(r); added++;
      }
    } catch (e) { console.warn(e); errors++; }
  }
  state.runs.sort((a, b) => a.date.localeCompare(b.date));
  save(); render();
  toast(`Imported ${added} run${added === 1 ? '' : 's'}${metrics ? ` + ${metrics} health values` : ''}${errors ? `, ${errors} file(s) failed` : ''}`);
}

async function fbSync(quiet = false) {
  try {
    if (!quiet) toast('Syncing…', 1200);
    const fresh = [];
    const rep = await health.sync(state, (r) => { matchRun(state, r); fresh.push(r); });
    for (const r of fresh) if (Date.now() - Date.parse(r.startTime) < 36 * 3600e3) attachSongs(r);
    state.fitbit.error = rep.errors.length ? rep.errors.join(' · ') : null;
    save(); render();
    cloudSync(true);
    const extra = Object.keys(rep.metrics).map((k) => health.METRICS[k].label).join(', ');
    if (!quiet) toast(`Synced ${rep.runs} new run(s), ${rep.rhr} HR days, ${rep.sleep} nights${extra ? `, plus ${extra}` : ''}`);
  } catch (e) {
    state.fitbit.error = e.message; save(); render();
    if (!quiet) toast(e.message);
  }
}

const actions = {
  tab: (d) => { tab = d.tab; localStorage.setItem('stride.tab', tab); render(); window.scrollTo(0, 0); },
  openWorkout: (d) => openWorkout(d.id),
  openGym: (d) => openGym(workoutById(state, d.id)),
  openGymSession: (d) => openGym(null, d.key),
  closeSheet,
  logRun: (d) => openLogRun(d.id),
  startRun: (d) => startRun(d.id),
  skip: (d) => { state.completions[d.id] = { status: 'skipped', at: Date.now() }; save(); closeSheet(); render(); },
  unmark: (d) => {
    const c = state.completions[d.id];
    if (c?.runId) { const r = state.runs.find((x) => x.id === c.runId); if (r) r.workoutId = null; }
    delete state.completions[d.id]; tombstone(`c:${d.id}`); save(); closeSheet(); render();
  },
  swapEasy: (d) => {
    const p = currentPaces(state);
    for (const wk of state.plan.weeks) wk.workouts = wk.workouts.map((w) => (w.id === d.id ? swapToEasy(w, p) : w));
    state.planAt = Date.now();
    save(); closeSheet(); render(); toast('Swapped to an easy run');
  },
  dismiss: (d) => { state.dismissed[d.id] = today(); save(); render(); },
  insight: (d) => {
    if (d.do === 'swapEasy') actions.swapEasy({ id: d.arg });
    if (d.do === 'scalePlan') { state.profile.volumeScale = round1((state.profile.volumeScale ?? 1) * Number(d.arg) * 100) / 100; rebuildPlan(); render(); toast('Future volume reduced'); }
    if (d.do === 'setVdot') { state.profile.vdot = Number(d.arg); rebuildPlan(); render(); toast(`Paces updated to VDOT ${d.arg}`); }
  },
  editVdot: () => {
    openSheet(`<h2>Adjust fitness</h2><p class="muted small">VDOT sets every pace in your plan. Raise it after a strong race. Lower it if sessions feel too hard.</p>
      <form id="vdotForm"><label>VDOT<input type="number" step="0.5" min="20" max="85" name="v" value="${state.profile.vdot}"></label>
      <button class="btn primary block">Update paces</button></form>`);
    $('#vdotForm').addEventListener('submit', (e) => { e.preventDefault(); const v = Number(new FormData(e.target).get('v')); if (v >= 20 && v <= 85) { state.profile.vdot = v; rebuildPlan(); } closeSheet(); render(); });
  },
  deleteRun: (d) => {
    if (!confirm('Delete this run?')) return;
    state.runs = state.runs.filter((r) => r.id !== d.id);
    tombstone(`r:${d.id}`);
    closeSheet();
    for (const [k, c] of Object.entries(state.completions)) if (c.runId === d.id) { delete state.completions[k]; tombstone(`c:${k}`); }
    save(); render();
  },
  deleteGym: (d) => {
    if (!confirm('Delete this session log?')) return;
    state.gymLogs = state.gymLogs.filter((l) => l.id !== d.id);
    tombstone(`g:${d.id}`);
    for (const [k, c] of Object.entries(state.completions)) if (c.logId === d.id) { delete state.completions[k]; tombstone(`c:${k}`); }
    save(); render();
  },
  editProfile: () => { editingProfile = true; render(); window.scrollTo(0, 0); },
  cancelEdit: () => { editingProfile = false; render(); },
  signIn: () => {
    if (!google.clientId()) {
      const id = prompt('One-time setup: paste your Google OAuth Client ID (see README)');
      if (!id) return;
      google.setClientId(id);
    }
    try { google.authorize(state); } catch (e) { toast(e.message); }
  },
  signOut: () => {
    if (!confirm('Sign out? Your data stays on this device and in your Google account.')) return;
    google.signOut(state); save(true); render(); toast('Signed out');
  },
  saveClientId: () => { google.setClientId($('#clientId').value); toast('Client ID saved'); },
  syncCloud: () => cloudSync(),
  usePlanHere: () => {
    if (!confirm('Make this plan the one on all your devices? Other devices switch to it on their next sync. Runs and gym logs are kept everywhere.')) return;
    state.planAt = Date.now(); save(); cloudSync();
  },
  openRun: (d) => openRun(d.id),
  openRecovery, openStrain, openSleep,
  editTiles: openTileEditor,
  setUnits: (d) => { state.settings.units = d.u; state.settingsAt = Date.now(); save(); render(); },
  testVoice: () => speak(isMi() ? '1 mile. Time 8 minutes 30 seconds. Split pace 8 30. Average pace 8 32.' : '1 kilometre. Time 5 minutes 15 seconds. Split pace 5 15. Average pace 5 18.'),
  stravaConnect: () => {
    const c = strava.cfg(state);
    c.clientId = $('#stravaId').value.trim(); c.clientSecret = $('#stravaSecret').value.trim();
    state.integrationsAt = Date.now(); save();
    try { strava.connect(state, google.redirectUri()); } catch (e) { toast(e.message); }
  },
  stravaSync: () => stravaSync(),
  stravaDisconnect: () => { if (confirm('Disconnect Strava?')) { strava.disconnect(state); state.integrationsAt = Date.now(); save(); render(); } },
  pushStrava: (d) => { const r = state.runs.find((x) => x.id === d.id); if (r) { delete r.stravaFailed; pushToStrava(r).then(() => openRun(r.id)); } },
  findSongs: (d) => { const r = state.runs.find((x) => x.id === d.id); if (r) attachSongs(r, false).then(() => openRun(r.id)); },
  spotifyConnect: () => {
    state.integrations.spotify = { clientId: $('#spotifyId').value.trim() };
    state.integrationsAt = Date.now(); save();
    spotify.connect(state, google.redirectUri()).catch((e) => toast(e.message));
  },
  spotifyDisconnect: () => { spotify.disconnect(); render(); },
  fbConnect: () => { try { google.authorize(state, { health: true }); } catch (e) { toast(e.message); } },
  fbSync: () => fbSync(),
  exportData: () => {
    const blob = new Blob([JSON.stringify({ ...state, auth: null, fitbit: { ...state.fitbit, tokens: null, lastRaw: null } }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stride-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  reset: () => { if (confirm('Delete your plan, runs and gym logs from this device?')) { resetState(); render(); } },
  tStart: () => tracker.start(),
  tPause: () => tracker.pause(),
  tResume: () => tracker.resume(),
  tNext: () => { tracker.next(); renderTracker(); },
  tFinish: () => { if (confirm('Finish and save this run?')) finishRun(); },
  tStats: () => tracker?.speakStats(),
  tDiscard: () => { stopNowPlaying(); tracker = null; trackerEl.hidden = true; trackerEl.innerHTML = ''; document.body.classList.remove('noscroll'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], [data-tab]');
  if (!el) return;
  if (el.dataset.tab && !el.dataset.act) return actions.tab(el.dataset);
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); e.stopPropagation(); fn(el.dataset); }
});
document.addEventListener('change', async (e) => {
  const vk = e.target.dataset?.voice;
  if (vk) {
    state.settings.voice = { ...DEFAULT_VOICE, ...state.settings.voice, [vk]: vk === 'every' ? Number(e.target.value) : e.target.checked };
    state.settingsAt = Date.now(); save(); return;
  }
  if (e.target.dataset?.actChange === 'stravaAuto') { strava.cfg(state).autoPush = e.target.checked; state.integrationsAt = Date.now(); save(); return; }
  if (e.target.id === 'importFiles') importFiles([...e.target.files]);
  if (e.target.id === 'importBackup') {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!data.profile) throw new Error('Not a Stride backup');
      if (confirm('Replace all data on this device with this backup?')) { replaceState(data); render(); toast('Backup restored'); }
    } catch (err) { toast(err.message); }
  }
});

// ---------------- cloud sync ----------------
let syncing = null;
async function cloudSync(quiet = false) {
  if (!google.hasToken(state)) return;
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const { restored } = await syncNow(state);
      state.syncError = null;
      save(true);
      if (restored) { editingProfile = false; tab = 'today'; toast(`Welcome back${state.auth.name ? `, ${state.auth.name}` : ''}! Plan restored`); }
      else if (!quiet) toast('Synced');
      render();
    } catch (e) {
      state.syncError = /drive/i.test(e.message) || e.status === 403 ? `Sync failed: ${e.message}. Is the Google Drive API enabled in your Google Cloud project?` : `Sync failed: ${e.message}`;
      save(true); render();
      if (!quiet) toast(state.syncError);
    } finally { syncing = null; }
  })();
  return syncing;
}

// push local changes a few seconds after they happen
let pushTimer;
onChange(() => {
  if (!google.hasToken(state)) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => cloudSync(true), 4000);
});

const STALE_MS = 15 * 60e3;
const fitbitStale = () => !state.fitbit.lastSync || Date.now() - Date.parse(state.fitbit.lastSync) > STALE_MS;
const stravaStale = () => { const l = strava.cfg(state).lastSync; return !l || Date.now() - Date.parse(l) > STALE_MS; };

async function freshen() {
  if (tracker) return; // never redirect away mid-run
  if (google.hasToken(state)) {
    if (Date.now() - (state.auth.syncedAt || 0) > 60e3 || state.dirtyAt) await cloudSync(true);
    if (google.healthOk(state) && fitbitStale()) fbSync(true);
    if (strava.connected(state) && stravaStale()) stravaSync(true);
    if (!google.healthOk(state) && fitbitStale()) google.maybeSilentRefresh(state, { health: true });
    return;
  }
  if (strava.connected(state) && stravaStale()) stravaSync(true);
  // token expired: silently refresh if there's something to sync
  const base = state.dirtyAt > (state.auth?.syncedAt || 0) || Date.now() - (state.auth?.syncedAt || 0) > 10 * 60e3;
  google.maybeSilentRefresh(state, { base, health: fitbitStale() });
}

// Strava / Spotify return with ?code=…&state=…
async function handleCodeReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.get('code') && !q.get('error')) return false;
  history.replaceState(null, '', location.pathname);
  let flow = {};
  try { flow = JSON.parse(localStorage.getItem('stride.codeFlow') || '{}'); } catch { /* ignore */ }
  tab = 'settings';
  const name = flow.provider === 'spotify' ? 'Spotify' : 'Strava';
  if (q.get('state') !== flow.st) { toast('Connection expired, please try again'); return true; }
  if (q.get('error')) { toast(`${name} connection cancelled`); return true; }
  try {
    if (flow.provider === 'strava') {
      await strava.finishConnect(state, q.get('code'), q.get('scope'));
      strava.cfg(state).error = null;
      state.integrationsAt = Date.now(); save();
      toast('Strava connected');
      stravaSync(true);
    } else if (flow.provider === 'spotify') {
      await spotify.finishConnect(state, q.get('code'), flow.verifier, google.redirectUri());
      toast('Spotify connected');
    }
  } catch (e) {
    if (flow.provider === 'strava') strava.cfg(state).error = e.message;
    save(true); toast(e.message);
  }
  return true;
}

// ---------------- boot ----------------
(async () => {
  await handleCodeReturn();
  const r = await google.handleRedirect(state);
  if (r) {
    save(true);
    if (r.error) toast(r.error);
    if (r.ok && r.firstSignIn) toast(`Signed in as ${state.auth.email}`);
    if (r.ok && r.healthRequested) {
      tab = 'settings';
      if (!state.auth.healthGranted) state.fitbit.error = 'Google didn’t grant the Fitbit/Health permissions. Make sure all boxes are ticked, and that the Google Health API is enabled for your project.';
    }
  }
  render();
  if (r?.ok) {
    if (google.hasToken(state)) await cloudSync(true);
    if (google.healthOk(state)) fbSync(!r.healthRequested);
    if (!r.healthRequested) await freshen();
  } else await freshen();
})();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') freshen(); });
// while the app is open: cloud sync every minute, Fitbit + Strava every 15 min
setInterval(() => {
  if (document.visibilityState !== 'visible' || tracker) return;
  if (google.hasToken(state)) {
    if (state.dirtyAt || Date.now() - (state.auth.syncedAt || 0) > 60e3) cloudSync(true);
    if (google.healthOk(state) && fitbitStale()) fbSync(true);
  }
  if (strava.connected(state) && stravaStale()) stravaSync(true);
}, 60e3);
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // reload once when a new version takes over, so the Home Screen app never runs stale code
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded && !tracker) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
  }).catch(() => {});
}
