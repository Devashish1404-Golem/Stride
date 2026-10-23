// Fitbit data via the Google Health API (v4), which replaces the legacy Fitbit Web API
// (shut down 30 Oct 2026). Browser-only: Google OAuth 2.0 token flow, no backend, no client secret.
//
// The v4 response shapes are new, so parsing is deliberately defensive: it searches each data
// point for start time / distance / duration / heart-rate fields rather than assuming exact names.
// Settings → "Show last raw response" lets you inspect what came back.

import { ymd, uid, addDays, today, haversine } from './util.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://health.googleapis.com/v4/users/me/dataTypes';
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];

export const redirectUri = () => location.origin + location.pathname;
export const isConnected = (fb) => !!(fb.tokens?.access_token && fb.tokens.expires_at > Date.now());

export function connect(fb) {
  if (!fb.clientId) throw new Error('Add your Google OAuth Client ID first.');
  const st = Math.random().toString(36).slice(2);
  localStorage.setItem('stride.oauthState', st);
  const q = new URLSearchParams({
    client_id: fb.clientId, redirect_uri: redirectUri(), response_type: 'token',
    scope: SCOPES.join(' '), state: st, prompt: 'consent',
  });
  location.href = `${AUTH_URL}?${q}`;
}

// Call on startup: picks up #access_token=… after Google redirects back.
export function handleRedirect(fb) {
  if (!location.hash.includes('access_token') && !location.hash.includes('error=')) return false;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (h.get('state') !== localStorage.getItem('stride.oauthState')) { fb.error = 'Sign-in state mismatch. Try connecting again.'; return true; }
  if (h.get('error')) { fb.error = `Google sign-in failed: ${h.get('error')}`; return true; }
  fb.tokens = { access_token: h.get('access_token'), expires_at: Date.now() + (Number(h.get('expires_in')) || 3600) * 1000 - 60000 };
  fb.error = null;
  return true;
}

export function disconnect(fb) { fb.tokens = null; }

async function get(fb, path, params = {}) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${fb.tokens.access_token}` } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  fb.lastRaw = { path, status: res.status, body: typeof body === 'string' ? body.slice(0, 4000) : body };
  if (res.status === 401) { fb.tokens = null; throw new Error('Google session expired. Tap Connect again.'); }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${body?.error?.message || ''}`);
  return body;
}

async function listAll(fb, type, maxPages = 5) {
  const points = [];
  let pageToken;
  for (let i = 0; i < maxPages; i++) {
    const body = await get(fb, `${type}/dataPoints`, { pageSize: 200, ...(pageToken ? { pageToken } : {}) });
    points.push(...(body.dataPoints || body.points || []));
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return points;
}

// ---------- defensive field extraction ----------
function walk(obj, fn, path = '') {
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { fn(k, v, path); walk(v, fn, `${path}.${k}`); }
}
function findVal(obj, keyRe, test = () => true) {
  let out;
  walk(obj, (k, v, path) => { if (out === undefined && keyRe.test(k) && test(v, path)) out = v; });
  return out;
}
const isTime = (v) => typeof v === 'string' && !isNaN(Date.parse(v));
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(+v) ? +v : NaN);
const isNum = (v) => !isNaN(num(v));
// "1800s" | "1800.5s" | number(seconds) -> seconds
const dur = (v) => (typeof v === 'string' && /^[\d.]+s$/.test(v) ? parseFloat(v) : num(v));

function distanceKm(p) {
  let km;
  walk(p, (k, v) => {
    if (km !== undefined || !/distance/i.test(k) || !isNum(v)) return;
    const n = num(v);
    km = /millimet/i.test(k) ? n / 1e6 : /kilomet/i.test(k) ? n : /mile/i.test(k) ? n * 1.609344 : n / 1000; // default: metres
  });
  return km;
}

export function parseExercise(p) {
  const type = String(findVal(p, /(exercise|activity)Type|type$/i, (v) => typeof v === 'string') ?? '');
  const name = String(findVal(p, /displayName|title|name$/i, (v) => typeof v === 'string' && !v.includes('/')) ?? '');
  if (!/run|jog|treadmill/i.test(type + ' ' + name)) return null;
  const start = findVal(p, /start(Time)?$/i, isTime);
  const end = findVal(p, /end(Time)?$/i, isTime);
  let sec = dur(findVal(p, /activeDuration|movingDuration/i, (v) => isNum(dur(v))));
  if (!isFinite(sec) && start && end) sec = (Date.parse(end) - Date.parse(start)) / 1000;
  const km = distanceKm(p);
  if (!start || !km || !isFinite(sec)) return null;
  const hr = num(findVal(p, /average.*heart|heart.*average|avg.*(hr|heart)/i, isNum));
  const maxHr = num(findVal(p, /max.*heart|heart.*max|peak.*heart/i, isNum));
  const cal = num(findVal(p, /calorie|energy/i, isNum));
  return {
    id: uid(), extId: p.name || `${start}-${km}`, source: 'fitbit', name: name || 'Fitbit run',
    date: ymd(new Date(start)), startTime: start, distKm: Math.round(km * 100) / 100,
    durSec: Math.round(sec), avgHr: isNaN(hr) ? null : Math.round(hr),
    maxHr: isNaN(maxHr) ? null : Math.round(maxHr), calories: isNaN(cal) ? null : Math.round(cal),
  };
}

// Daily health metrics beyond resting HR and sleep. Each is fetched best-effort: if Google
// doesn't expose a type for your account/device, it's skipped without breaking the sync.
export const METRICS = {
  vo2max: { type: 'daily-vo2-max', label: 'VO₂ max', unit: 'ml/kg/min', re: /vo2|estimate|value/i, dp: 1 },
  hrv: { type: 'daily-heart-rate-variability', label: 'HRV', unit: 'ms', re: /rmssd|millis|hrv|value/i, dp: 0 },
  spo2: { type: 'daily-oxygen-saturation', label: 'SpO₂', unit: '%', re: /percent|average|saturation|value/i, dp: 1 },
  resp: { type: 'daily-respiratory-rate', label: 'Breathing rate', unit: 'br/min', re: /breath|rate|value/i, dp: 1 },
  skinTemp: { type: 'daily-skin-temperature', label: 'Skin temp vs baseline', unit: '°C', re: /celsius|deviation|relative|value/i, dp: 1 },
  steps: { type: 'daily-steps', label: 'Steps', unit: '', re: /count|steps|value/i, dp: 0 },
  weight: { type: 'weight', label: 'Weight', unit: 'kg', re: /kilogram|grams|weight|value/i, dp: 1, grams: true },
};

function parseDaily(p, valueRe) {
  const v = num(findVal(p, valueRe, isNum));
  let date = findVal(p, /^date$|civilDate/i, (x) => typeof x === 'string' || typeof x === 'object');
  if (date && typeof date === 'object' && date.year) date = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  if (typeof date === 'string' && date.length > 10) date = ymd(new Date(date));
  if (!date) { const t = findVal(p, /start(Time)?$|time$/i, isTime); if (t) date = ymd(new Date(t)); }
  return date && !isNaN(v) ? { date, v } : null;
}

function parseSleep(p) {
  const end = findVal(p, /end(Time)?$/i, isTime);
  const start = findVal(p, /start(Time)?$/i, isTime);
  if (!end) return null;
  let min = num(findVal(p, /minutesAsleep|asleep.*(min|duration)/i, (v) => isNum(dur(v))));
  if (isNaN(min)) {
    const d = dur(findVal(p, /asleepDuration|sleepDuration/i, (v) => isNum(dur(v))));
    min = isFinite(d) ? d / 60 : start ? (Date.parse(end) - Date.parse(start)) / 60000 : NaN;
  }
  return isNaN(min) ? null : { date: ymd(new Date(end)), min: Math.round(min) };
}

export async function sync(state, onRun) {
  const fb = state.fitbit;
  if (!isConnected(fb)) throw new Error('Not connected.');
  const since = addDays(today(), -60);
  const report = { runs: 0, rhr: 0, sleep: 0, metrics: {}, errors: [] };

  try {
    const known = new Set(state.runs.map((r) => r.extId).filter(Boolean));
    for (const p of await listAll(fb, 'exercise')) {
      const r = parseExercise(p);
      if (!r || r.date < since || known.has(r.extId)) continue;
      // de-dupe against GPS runs recorded in this app at the same time
      if (state.runs.some((x) => x.date === r.date && Math.abs(x.distKm - r.distKm) < 0.3 && x.startTime && Math.abs(Date.parse(x.startTime) - Date.parse(r.startTime)) < 15 * 60000)) continue;
      state.runs.push(r); onRun?.(r); report.runs++;
    }
  } catch (e) { report.errors.push(`Runs: ${e.message}`); }

  try {
    for (const p of await listAll(fb, 'daily-resting-heart-rate', 2)) {
      const d = parseDaily(p, /beatsPerMinute|bpm|restingHeartRate|value/i);
      if (d && d.date >= since) { state.fitbit.rhr[d.date] = Math.round(d.v); report.rhr++; }
    }
  } catch (e) { report.errors.push(`Resting HR: ${e.message}`); }

  try {
    for (const p of await listAll(fb, 'sleep', 2)) {
      const s = parseSleep(p);
      if (s && s.date >= since) { state.fitbit.sleep[s.date] = Math.max(state.fitbit.sleep[s.date] || 0, s.min); report.sleep++; }
    }
  } catch (e) { report.errors.push(`Sleep: ${e.message}`); }

  fb.metrics ||= {};
  for (const [key, m] of Object.entries(METRICS)) {
    try {
      for (const p of await listAll(fb, m.type, 2)) {
        const d = parseDaily(p, m.re);
        if (!d || d.date < since) continue;
        let v = d.v;
        if (m.grams && v > 1000) v /= 1000; // grams -> kg
        (fb.metrics[key] ||= {})[d.date] = +v.toFixed(m.dp);
        report.metrics[key] = (report.metrics[key] || 0) + 1;
      }
    } catch (e) { fb.metricErrors = { ...(fb.metricErrors || {}), [key]: e.message }; }
  }

  state.runs.sort((a, b) => a.date.localeCompare(b.date));
  fb.lastSync = new Date().toISOString();
  return report;
}

// ---------- file imports (work regardless of API access) ----------

// Fitbit / Google Takeout export daily files. Returns how many values were stored, or -1 if not recognised.
const fbDate = (s) => { const m = String(s).match(/^(\d\d)\/(\d\d)\/(\d\d)/); return m ? `20${m[3]}-${m[1]}-${m[2]}` : String(s).slice(0, 10); };
export function importFitbitDaily(filename, json, fb) {
  const f = filename.toLowerCase();
  const arr = Array.isArray(json) ? json : [];
  const put = (key, date, v) => { if (date && isFinite(v)) { (fb.metrics[key] ||= {})[date] = v; n++; } };
  let n = 0;
  fb.metrics ||= {};
  if (f.includes('vo2_max')) arr.forEach((x) => put('vo2max', fbDate(x.dateTime), +(x.value?.filteredDemographicVO2Max ?? x.value?.demographicVO2Max)?.toFixed(1)));
  else if (f.includes('resting_heart_rate')) arr.forEach((x) => { const v = x.value?.value; if (v) { fb.rhr[fbDate(x.dateTime)] = Math.round(v); n++; } });
  else if (f.startsWith('sleep')) arr.forEach((x) => { if (x.mainSleep !== false && x.minutesAsleep) { const d = x.dateOfSleep || fbDate(x.endTime); fb.sleep[d] = Math.max(fb.sleep[d] || 0, x.minutesAsleep); n++; } });
  else if (f.includes('weight')) arr.forEach((x) => put('weight', fbDate(x.date || x.dateTime), +(+x.weight).toFixed(1)));
  else return -1;
  return n;
}

// Fitbit / Google Takeout export: exercise-*.json files (array of activity logs).
export function parseFitbitExport(json) {
  const arr = Array.isArray(json) ? json : json.activities || [];
  return arr.filter((a) => /run|treadmill/i.test(a.activityName || '') && a.distance).map((a) => {
    const unit = (a.distanceUnit || 'Kilometer').toLowerCase();
    const km = unit.startsWith('mile') ? a.distance * 1.609344 : a.distance;
    const start = new Date(a.startTime.replace(/^(\d\d)\/(\d\d)\/(\d\d) /, '20$3-$1-$2T'));
    return {
      id: uid(), extId: `fb-${a.logId}`, source: 'fitbit', name: a.activityName,
      date: ymd(start), startTime: start.toISOString(), distKm: Math.round(km * 100) / 100,
      durSec: Math.round((a.activeDuration || a.duration) / 1000), avgHr: a.averageHeartRate || null,
    };
  });
}

// GPX or TCX (Fitbit, Garmin, Strava, Apple Health exports).
export function parseTrackFile(text, filename = '') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const pts = [...doc.querySelectorAll('trkpt, Trackpoint')].map((n) => {
    const lat = n.getAttribute('lat') ?? n.querySelector('LatitudeDegrees')?.textContent;
    const lon = n.getAttribute('lon') ?? n.querySelector('LongitudeDegrees')?.textContent;
    const time = n.querySelector('time, Time')?.textContent;
    const hr = n.querySelector('hr, HeartRateBpm Value')?.textContent;
    return { lat: +lat, lon: +lon, t: time ? Date.parse(time) : NaN, hr: hr ? +hr : null };
  }).filter((p) => !isNaN(p.t));
  if (pts.length < 2) throw new Error('No timed track points found in file.');
  let m = 0;
  const geo = pts.filter((p) => p.lat && p.lon);
  for (let i = 1; i < geo.length; i++) m += haversine([geo[i - 1].lat, geo[i - 1].lon], [geo[i].lat, geo[i].lon]);
  const tcxDist = [...doc.querySelectorAll('Lap > DistanceMeters')].reduce((a, n) => a + +n.textContent, 0);
  if (!m && tcxDist) m = tcxDist;
  const hrs = pts.map((p) => p.hr).filter(Boolean);
  const start = new Date(pts[0].t);
  return {
    id: uid(), source: 'file', name: filename.replace(/\.(gpx|tcx)$/i, '') || 'Imported run',
    date: ymd(start), startTime: start.toISOString(), distKm: Math.round(m / 10) / 100,
    durSec: Math.round((pts[pts.length - 1].t - pts[0].t) / 1000),
    avgHr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b) / hrs.length) : null,
    route: geo.filter((_, i) => i % 5 === 0).map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)]),
  };
}
