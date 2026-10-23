import { $, $$, esc, today, addDays, fmtDate, fmtPace, fmtDur, parseDur, fmtKm, daysBetween, mondayOf, dow, DOW, DOW_LONG, round1, sum, uid, clamp } from './util.js';
import { state, save, replaceState, resetState } from './store.js';
import { vdotFrom, vdotFromEasyPace, predictTime, DISTANCES, ZONES } from './vdot.js';
import { generatePlan, mergePlans, allWorkouts, weekOf, swapToEasy } from './plan.js';
import { EXERCISES, sessionByKey, allSessions, suggestLoad } from './gym.js';
import { insights, readiness, matchRun, currentPaces, runKmBetween, workoutById, fitnessEstimate } from './coach.js';
import * as health from './health.js';
import { RunTracker } from './tracker.js';

const app = $('#app');
const sheetEl = $('#sheet');
const trackerEl = $('#tracker');
let tab = localStorage.getItem('stride.tab') || 'today';
let tracker = null;
let editingProfile = false;

// ---------------- helpers ----------------
const TYPE_COLOR = { easy: 'var(--z-easy)', long: 'var(--z-long)', intervals: 'var(--z-i)', tempo: 'var(--z-t)', mp: 'var(--z-m)', hills: 'var(--z-r)', race: 'var(--accent)', gym: 'var(--gym)' };
const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;

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
const paceRange = (z, p) => `${fmtPace(p[z].lo)}–${fmtPace(p[z].hi)}`;
const stepAmount = (s) => (s.dist ? (s.dist >= 1000 ? `${+(s.dist / 1000).toFixed(2)} km` : `${s.dist} m`) : s.time >= 60 ? `${+(s.time / 60).toFixed(1)} min` : `${s.time} s`);

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
    <div class="pace">${paceRange(s.zone, p)}<small>/km</small></div></div>`;
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
  const est = w.kind === 'run' ? `${fmtKm(w.km)} km · ~${fmtDur(estSec(w, p)).replace(/:\d\d$/, '')} ${estSec(w, p) >= 3600 ? 'h' : 'min'}` : w.summary;
  return `<div class="wcard ${st || ''}" style="--c:${color}" data-act="${w.kind === 'gym' ? 'openGym' : 'openWorkout'}" data-id="${w.id}">
    <div class="wbar"></div>
    <div class="grow">
      ${opts.showDate ? `<div class="eyebrow">${fmtDate(w.date)}</div>` : ''}
      <div class="wtitle">${esc(w.title)} ${st === 'done' ? `<span class="chip good">${icon('check')} Done</span>` : st === 'skipped' ? '<span class="chip">Skipped</span>' : ''}</div>
      <div class="muted">${esc(w.kind === 'run' ? w.summary : est)}</div>
      ${w.kind === 'run' ? `<div class="meta">${run ? `${fmtKm(run.distKm)} km · ${fmtDur(run.durSec)} · ${fmtPace(run.durSec / run.distKm)}/km` : est}</div>` : ''}
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
    </form></div>`;
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
  save();
}

// ---------------- views ----------------
function viewToday() {
  const t = today();
  const p = currentPaces(state);
  const pr = state.profile;
  const dtr = daysBetween(t, pr.raceDate);
  const ws = allWorkouts(state.plan);
  const todays = ws.filter((w) => w.date === t);
  const upcoming = ws.filter((w) => w.date > t).slice(0, 4);
  const wk = weekOf(state.plan, t);
  const rd = readiness(state);
  const ins = insights(state).slice(0, 3);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  let weekStrip = '';
  if (wk) {
    const doneKm = runKmBetween(state.runs, wk.start, addDays(wk.start, 6));
    weekStrip = `<section class="card">
      <div class="row between"><h3>This week</h3><span class="muted">${fmtKm(doneKm)} / ${fmtKm(wk.plannedKm)} km</span></div>
      <div class="bar"><span style="width:${Math.min(100, (doneKm / Math.max(1, wk.plannedKm)) * 100)}%"></span></div>
      <div class="strip">${[0, 1, 2, 3, 4, 5, 6].map((d) => {
        const date = addDays(wk.start, d);
        const dw = wk.workouts.filter((w) => w.date === date);
        return `<div class="sd ${date === t ? 'today' : ''}"><span>${DOW[d][0]}</span>${dw.map((w) => `<i class="dot ${statusOf(w) || (date < t ? 'missed' : '')}" style="--c:${TYPE_COLOR[w.type]}"></i>`).join('') || '<i class="dot rest"></i>'}</div>`;
      }).join('')}</div></section>`;
  }

  const starts = state.plan.start > t ? `<section class="card hero-sub">${icon('calendar')} Your plan starts <b>${fmtDate(state.plan.start)}</b>. Until then, keep running easy 3–4× a week and get a couple of strength sessions in.</section>` : '';

  return `<header class="top">
      <div><div class="eyebrow">${fmtDate(t, { weekday: 'long', day: 'numeric', month: 'long' })}</div><h1>${greet}${pr.name ? `, ${esc(pr.name)}` : ''}</h1></div>
      <div class="countdown"><b>${dtr}</b><span>days to<br>${DISTANCES[pr.goal].label.replace(' marathon', '')}</span></div>
    </header>
    ${starts}
    ${rd ? `<section class="card readiness"><div class="ring" style="--v:${rd.score}"><b>${rd.score}</b></div><div><b>${rd.label}</b><div class="muted small">${esc(rd.notes.join(' · '))}</div></div></section>` : ''}
    <h2 class="sec">Today</h2>
    ${todays.length ? todays.map((w) => workoutCard(w, p, { cta: true })).join('') : `<div class="wcard rest"><div class="grow"><div class="wtitle">Rest day</div><div class="muted">Recovery is where the adaptation happens. A walk or 10 minutes of mobility is plenty.</div></div></div>`}
    <button class="btn ghost block" data-act="startRun" data-id="">${icon('play')} Start a free run</button>
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
        <div class="wkkm"><b>${fmtKm(w.plannedKm)}</b> km${w.start <= t ? `<div class="muted small">${fmtKm(done)} done</div>` : ''}</div></summary>
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
    ws, actual: ws <= t ? runKmBetween(state.runs, ws, addDays(ws, 6)) : null,
    planned: weekOf(state.plan, ws)?.plannedKm ?? 0, cur: ws === mondayOf(t),
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

function rhrChart() {
  const t = today();
  const pts = Array.from({ length: 30 }, (_, i) => addDays(t, i - 29)).map((d) => state.fitbit.rhr[d]).map((v, i) => [i, v]).filter(([, v]) => v);
  if (pts.length < 3) return '';
  const vs = pts.map(([, v]) => v), lo = Math.min(...vs) - 2, hi = Math.max(...vs) + 2;
  const W = 340, H = 70;
  const path = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${(i / 29) * W},${H - ((v - lo) / (hi - lo)) * H}`).join(' ');
  return `<section class="card"><div class="row between"><h3>Resting heart rate</h3><span class="muted">${vs[vs.length - 1]} bpm</span></div>
    <svg viewBox="0 -4 ${W} ${H + 8}" class="chart"><path d="${path}" class="line"/></svg><p class="muted small">30 days. A rising trend often means fatigue, illness or stress.</p></section>`;
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
      ${['E', 'M', 'T', 'I', 'R'].map((z) => `<div class="step"><span class="zdot" style="background:${ZONES[z].color}"></span><div class="grow"><b>${ZONES[z].name}</b><div class="muted small">${ZONES[z].desc}</div></div><div class="pace">${paceRange(z, p)}<small>/km</small></div></div>`).join('')}
    </section>
    <section class="card"><h3>Weekly distance</h3>${weeklyChart()}</section>
    ${rhrChart()}
    <h2 class="sec">Coach insights</h2>
    ${ins.length ? ins.map(insightCard).join('') : '<p class="muted">Log a few runs and the coach starts adapting your plan.</p>'}
    <div class="row between"><h2 class="sec">Runs</h2><button class="btn sm" data-act="logRun" data-id="">+ Log run</button></div>
    ${runs.length ? runs.map((r) => {
      const w = r.workoutId && workoutById(state, r.workoutId);
      return `<div class="hist"><span class="zdot" style="background:${TYPE_COLOR[w?.type] || 'var(--muted)'}"></span><div class="grow"><b>${esc(w?.title || r.name || 'Run')}</b>
        <div class="muted small">${fmtDate(r.date)} · ${fmtKm(r.distKm)} km · ${fmtDur(r.durSec)} · ${fmtPace(r.durSec / r.distKm)}/km${r.avgHr ? ` · ${r.avgHr} bpm` : ''} · ${r.source}</div></div>
        <button class="x" data-act="deleteRun" data-id="${r.id}" aria-label="Delete run">×</button></div>`;
    }).join('') : '<p class="muted">No runs yet.</p>'}`;
}

function viewSettings() {
  const fb = state.fitbit;
  const pr = state.profile;
  const connected = health.isConnected(fb);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `<header class="top"><div><div class="eyebrow">Stride</div><h1>Settings</h1></div></header>
    ${!standalone ? `<section class="card hero-sub">${icon('share')} <div><b>Install on your iPhone</b><div class="muted small">In Safari tap Share → <b>Add to Home Screen</b>. It then opens full-screen like a native app. Connect Fitbit from inside the installed app, because iOS keeps its storage separate from Safari.</div></div></section>` : ''}
    <section class="card">
      <h3>Plan</h3>
      <p class="muted small">${DISTANCES[pr.goal].label} on ${fmtDate(pr.raceDate, { day: 'numeric', month: 'long', year: 'numeric' })} · ${pr.runDays.length} runs/week · ${pr.gymDays.length} gym/week · volume ×${pr.volumeScale ?? 1}</p>
      <button class="btn block" data-act="editProfile">Edit profile & rebuild plan</button>
    </section>
    <section class="card">
      <h3>Fitbit via Google Health</h3>
      <p class="muted small">Pulls runs (distance, time, heart rate), resting heart rate and sleep from your Fitbit through Google’s Health API. The old Fitbit Web API shuts down on 30 Oct 2026, so this uses Google’s replacement. See README for the one-time Google Cloud setup.</p>
      <label>Google OAuth Client ID<input id="clientId" value="${esc(fb.clientId)}" placeholder="1234-abc.apps.googleusercontent.com" autocapitalize="off" spellcheck="false"></label>
      <div class="muted small">Authorised redirect URI to register: <code>${esc(health.redirectUri())}</code></div>
      <div class="row gap">
        ${connected ? `<button class="btn primary" data-act="fbSync">${icon('sync')} Sync now</button><button class="btn ghost" data-act="fbDisconnect">Disconnect</button>`
          : `<button class="btn primary" data-act="fbConnect">Connect</button>`}
      </div>
      <div class="muted small">${fb.lastSync ? `Last sync ${new Date(fb.lastSync).toLocaleString()}` : 'Never synced'}${fb.tokens && !connected ? ' · session expired, reconnect' : ''}</div>
      ${fb.error ? `<div class="err">${esc(fb.error)}</div>` : ''}
      ${fb.lastRaw ? `<details><summary class="small">Show last raw response</summary><pre>${esc(JSON.stringify(fb.lastRaw, null, 1).slice(0, 3000))}</pre></details>` : ''}
    </section>
    <section class="card">
      <h3>Import runs</h3>
      <p class="muted small">GPX or TCX files from any watch or app, or <code>exercise-*.json</code> files from your Fitbit / Google Takeout data export. Runs on a planned day are matched to the plan automatically.</p>
      <label class="btn block file">Choose files<input type="file" id="importFiles" multiple accept=".gpx,.tcx,.json,application/json,application/gpx+xml"></label>
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="muted small">Everything is stored on this device only. Export a backup to move between Safari and the home-screen app, or to a new phone.</p>
      <div class="row gap"><button class="btn" data-act="exportData">Export</button><label class="btn file">Import<input type="file" id="importBackup" accept=".json,application/json"></label></div>
    </section>
    <section class="card"><button class="btn block danger" data-act="reset">Reset everything</button></section>
    <p class="muted small center">Stride gives training guidance, not medical advice. Stop and get checked if something hurts.</p>`;
}

function render() {
  if (!state.profile || !state.plan || editingProfile) { $('#tabs').hidden = true; return renderOnboarding(); }
  $('#tabs').hidden = false;
  const views = { today: viewToday, plan: viewPlan, gym: viewGym, progress: viewProgress, settings: viewSettings };
  app.innerHTML = `<div class="view">${(views[tab] || viewToday)()}</div>`;
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
    <p class="lead">${esc(w.summary)}</p>
    <div class="stats3"><div><b>${fmtKm(w.km)}</b><span>km</span></div><div><b>${fmtDur(estSec(w, p))}</b><span>est. time</span></div><div><b>${w.steps.length}</b><span>steps</span></div></div>
    <div class="steps">${stepsHtml(w, p)}</div>
    <div class="why"><b>Why this session</b><p>${esc(w.purpose)}</p></div>
    ${run ? `<div class="card done-card">${icon('check')} Completed: ${fmtKm(run.distKm)} km in ${fmtDur(run.durSec)} (${fmtPace(run.durSec / run.distKm)}/km)${run.avgHr ? `, ${run.avgHr} bpm` : ''}</div>` : ''}
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
      <label>Distance (km)<input type="number" step="0.01" name="km" required value="${w ? w.km : ''}" inputmode="decimal"></label></div>
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
    const distKm = Number(f.get('km'));
    if (!(durSec > 0) || !(distKm > 0)) return toast('Enter distance and time');
    const run = { id: uid(), source: 'manual', name: w?.title || 'Run', date: f.get('date'), distKm, durSec, avgHr: Number(f.get('hr')) || null, rpe: Number(f.get('rpe')), isRace: !!f.get('isRace') };
    addRun(run, w?.date === run.date ? w : null);
    closeSheet();
    toast(`Saved ${fmtKm(distKm)} km at ${fmtPace(durSec / distKm)}/km`);
  });
}

function addRun(run, workout) {
  if (workout) { run.workoutId = workout.id; state.completions[workout.id] = { status: 'done', runId: run.id }; }
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
    const log = { id: prev?.id || uid(), date: workout?.date || today(), workoutId: workout?.id, sessionKey: sess.sessionKey, title: sess.title, entries };
    state.gymLogs = state.gymLogs.filter((l) => l.id !== log.id);
    state.gymLogs.push(log);
    state.gymLogs.sort((a, b) => a.date.localeCompare(b.date));
    if (workout) state.completions[workout.id] = { status: 'done', logId: log.id };
    save(); closeSheet(); render();
    toast('Session saved 💪');
  });
}

// ---------------- guided run ----------------
function startRun(id) {
  const w = id ? workoutById(state, id) : null;
  closeSheet();
  tracker = new RunTracker(w, currentPaces(state), renderTracker);
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
      <h1>${tr.workout ? esc(tr.workout.summary) : 'Just run'}</h1>
      ${tr.workout ? `<div class="steps">${stepsHtml(tr.workout, p)}</div>` : ''}
      <p class="muted small">Keep the screen on and the app open. iOS pauses GPS for web apps when the phone is locked. Voice cues announce each step and every kilometre.</p>
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
      <div class="target">${ZONES[s.zone].name} · ${fmtPace(z.lo)}–${fmtPace(z.hi)}/km</div>
      ${rem ? `<div class="remain">${rem.kind === 'dist' ? `${Math.round(rem.v)} m` : fmtDur(rem.v)}<small> left</small></div>` : ''}
      <div class="bar"><span style="width:${tr.stepProgress() * 100}%"></span></div>
    </div>
    <div class="tgrid">
      <div><b>${fmtDur(tr.elapsed / 1000)}</b><span>time</span></div>
      <div><b>${(tr.dist / 1000).toFixed(2)}</b><span>km</span></div>
      <div><b>${fmtPace(cp)}</b><span>pace ${fb}</span></div>
      <div><b>${fmtPace(tr.avgPace)}</b><span>avg pace</span></div>
    </div>
    ${nxt ? `<div class="next muted">Next: ${esc(nxt.label)} · ${nxt.dist || nxt.time ? stepAmount(nxt) : ''} ${ZONES[nxt.zone].name}</div>` : ''}
    <div class="tbtns">
      ${tr.state === 'running' ? `<button class="btn xl" data-act="tPause">${icon('pause')} Pause</button>` : `<button class="btn xl primary" data-act="tResume">${icon('play')} Resume</button>`}
      <button class="btn xl" data-act="tNext">Skip step</button>
      <button class="btn xl danger" data-act="tFinish">Finish</button>
    </div></div>`;
}

function finishRun() {
  const run = tracker.finish();
  const w = tracker.workout;
  tracker = null;
  trackerEl.hidden = true;
  trackerEl.innerHTML = '';
  document.body.classList.remove('noscroll');
  if (run.distKm < 0.2) { toast('Run too short to save'); return; }
  openSheet(`<h2>Nice work!</h2>
    <div class="stats3"><div><b>${fmtKm(run.distKm)}</b><span>km</span></div><div><b>${fmtDur(run.durSec)}</b><span>time</span></div><div><b>${fmtPace(run.durSec / run.distKm)}</b><span>/km</span></div></div>
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
  });
}

// ---------------- actions ----------------
async function importFiles(files) {
  let added = 0, errors = 0;
  for (const file of files) {
    try {
      const text = await file.text();
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
  toast(`Imported ${added} run${added === 1 ? '' : 's'}${errors ? `, ${errors} file(s) failed` : ''}`);
}

async function fbSync(quiet = false) {
  try {
    if (!quiet) toast('Syncing…', 1200);
    const rep = await health.sync(state, (r) => matchRun(state, r));
    state.fitbit.error = rep.errors.length ? rep.errors.join(' · ') : null;
    save(); render();
    if (!quiet) toast(`Synced ${rep.runs} new run(s), ${rep.rhr} HR days, ${rep.sleep} nights`);
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
  skip: (d) => { state.completions[d.id] = { status: 'skipped' }; save(); closeSheet(); render(); },
  unmark: (d) => {
    const c = state.completions[d.id];
    if (c?.runId) { const r = state.runs.find((x) => x.id === c.runId); if (r) r.workoutId = null; }
    delete state.completions[d.id]; save(); closeSheet(); render();
  },
  swapEasy: (d) => {
    const p = currentPaces(state);
    for (const wk of state.plan.weeks) wk.workouts = wk.workouts.map((w) => (w.id === d.id ? swapToEasy(w, p) : w));
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
    for (const [k, c] of Object.entries(state.completions)) if (c.runId === d.id) delete state.completions[k];
    save(); render();
  },
  deleteGym: (d) => {
    if (!confirm('Delete this session log?')) return;
    state.gymLogs = state.gymLogs.filter((l) => l.id !== d.id);
    for (const [k, c] of Object.entries(state.completions)) if (c.logId === d.id) delete state.completions[k];
    save(); render();
  },
  editProfile: () => { editingProfile = true; render(); window.scrollTo(0, 0); },
  cancelEdit: () => { editingProfile = false; render(); },
  fbConnect: () => {
    state.fitbit.clientId = $('#clientId').value.trim(); save();
    try { health.connect(state.fitbit); } catch (e) { toast(e.message); }
  },
  fbSync: () => fbSync(),
  fbDisconnect: () => { health.disconnect(state.fitbit); save(); render(); },
  exportData: () => {
    const blob = new Blob([JSON.stringify({ ...state, fitbit: { ...state.fitbit, tokens: null, lastRaw: null } }, null, 1)], { type: 'application/json' });
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
  tDiscard: () => { tracker = null; trackerEl.hidden = true; trackerEl.innerHTML = ''; document.body.classList.remove('noscroll'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], [data-tab]');
  if (!el) return;
  if (el.dataset.tab && !el.dataset.act) return actions.tab(el.dataset);
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); e.stopPropagation(); fn(el.dataset); }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'importFiles') importFiles([...e.target.files]);
  if (e.target.id === 'importBackup') {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!data.profile) throw new Error('Not a Stride backup');
      if (confirm('Replace all data on this device with this backup?')) { replaceState(data); render(); toast('Backup restored'); }
    } catch (err) { toast(err.message); }
  }
});

// ---------------- boot ----------------
if (health.handleRedirect(state.fitbit)) { save(); tab = 'settings'; if (health.isConnected(state.fitbit)) fbSync(); }
render();
if (health.isConnected(state.fitbit) && (!state.fitbit.lastSync || Date.now() - Date.parse(state.fitbit.lastSync) > 3 * 3600e3)) fbSync(true);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
