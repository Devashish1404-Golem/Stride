// Strava: connect (OAuth), import runs + map outlines, push Stride runs.
// Strava's token exchange needs your app's Client Secret. It's stored only on your devices and in your
// own Google Drive sync file, never in the repo. Strava's refresh tokens are long-lived, so you connect once.

import { uid, ymd, addDays, today } from './util.js';
import { toGpx } from './route.js';

const API = 'https://www.strava.com/api/v3';
const RUN_TYPES = /^(Run|TrailRun|VirtualRun)$/;

export const cfg = (s) => (s.integrations ||= {}).strava ||= { autoPush: true };
export const connected = (s) => !!cfg(s).tokens?.refresh_token;

export function connect(s, redirectUri) {
  const c = cfg(s);
  if (!c.clientId || !c.clientSecret) throw new Error('Enter your Strava Client ID and Client Secret first.');
  const st = Math.random().toString(36).slice(2);
  localStorage.setItem('stride.codeFlow', JSON.stringify({ provider: 'strava', st }));
  const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirectUri, response_type: 'code', approval_prompt: 'auto', scope: 'read,activity:read_all,activity:write', state: st });
  location.href = `https://www.strava.com/oauth/authorize?${q}`;
}

async function token(s, params) {
  const c = cfg(s);
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Strava: ${body.message || res.status}`);
  c.tokens = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at };
  if (body.athlete) c.athlete = { name: [body.athlete.firstname, body.athlete.lastname].filter(Boolean).join(' '), id: body.athlete.id };
  return c.tokens;
}

export async function finishConnect(s, code, grantedScope) {
  if (grantedScope && !grantedScope.includes('activity:write')) throw new Error('Strava: please allow uploading activities (activity:write).');
  await token(s, { code, grant_type: 'authorization_code' });
  cfg(s).connectedAt = Date.now();
}

export function disconnect(s) {
  const c = cfg(s);
  if (c.tokens?.access_token) fetch('https://www.strava.com/oauth/deauthorize', { method: 'POST', headers: { Authorization: `Bearer ${c.tokens.access_token}` } }).catch(() => {});
  c.tokens = null; c.athlete = null;
}

async function api(s, path, opts = {}) {
  const c = cfg(s);
  if (!c.tokens) throw new Error('Strava not connected');
  if (c.tokens.expires_at * 1000 < Date.now() + 60000) await token(s, { grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token });
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${c.tokens.access_token}` } });
  if (res.status === 401) { c.tokens.expires_at = 0; throw new Error('Strava session expired, it will refresh next time'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Strava ${res.status}: ${body.message || ''} ${body.errors?.map((e) => e.code).join(',') || ''}`.trim());
  return body;
}

// Pull recent runs: attach map outlines/IDs to runs we already have, import the rest.
export async function sync(s, onNew) {
  const c = cfg(s);
  const after = Math.floor(Date.parse(c.lastSync ? addDays(c.lastSync.slice(0, 10), -3) : addDays(today(), -60)) / 1000);
  const acts = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await api(s, `/athlete/activities?after=${after}&per_page=100&page=${page}`);
    acts.push(...batch);
    if (batch.length < 100) break;
  }
  let added = 0, linked = 0;
  for (const a of acts) {
    if (!RUN_TYPES.test(a.sport_type || a.type)) continue;
    const t = Date.parse(a.start_date);
    const existing = s.runs.find((r) => r.stravaId === a.id) ||
      s.runs.find((r) => r.startTime && Math.abs(Date.parse(r.startTime) - t) < 15 * 60000 && Math.abs(r.distKm - a.distance / 1000) < 0.6);
    const poly = a.map?.summary_polyline || null;
    if (existing) {
      if (!existing.stravaId || (poly && !existing.polyline)) { existing.stravaId = a.id; if (poly) existing.polyline = poly; existing.at = Date.now(); linked++; }
      continue;
    }
    const r = {
      id: uid(), extId: `strava-${a.id}`, stravaId: a.id, source: 'strava', name: a.name,
      date: ymd(new Date(a.start_date_local.replace('Z', ''))), startTime: a.start_date,
      distKm: Math.round(a.distance / 10) / 100, durSec: a.moving_time,
      avgHr: a.average_heartrate ? Math.round(a.average_heartrate) : null, maxHr: a.max_heartrate || null,
      polyline: poly, at: Date.now(),
    };
    s.runs.push(r); onNew?.(r); added++;
  }
  s.runs.sort((a, b) => a.date.localeCompare(b.date));
  c.lastSync = new Date().toISOString();
  return { added, linked };
}

// Push a Stride run. GPS runs upload as GPX (map included); others become manual activities.
export async function push(s, run, description = '') {
  if (run.stravaId) return run.stravaId;
  const name = run.name || 'Run';
  let id;
  if (run.route?.length > 1) {
    const fd = new FormData();
    fd.append('file', new Blob([toGpx(run)], { type: 'application/gpx+xml' }), `stride-${run.id}.gpx`);
    fd.append('data_type', 'gpx');
    fd.append('name', name);
    fd.append('description', description);
    fd.append('external_id', `stride-${run.id}`);
    let up = await api(s, '/uploads', { method: 'POST', body: fd });
    for (let i = 0; i < 15 && !up.activity_id && !up.error; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      up = await api(s, `/uploads/${up.id_str || up.id}`);
    }
    if (up.error) {
      const dup = String(up.error).match(/duplicate of .*?(\d{6,})/);
      if (dup) id = Number(dup[1]); else throw new Error(`Strava upload: ${up.error}`);
    } else id = up.activity_id;
    if (!id) throw new Error('Strava is still processing the upload, it will be linked on the next sync');
    await api(s, `/activities/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sport_type: 'Run' }) }).catch(() => {});
  } else {
    const a = await api(s, '/activities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, sport_type: 'Run', start_date_local: (run.startTime ? new Date(run.startTime) : new Date(`${run.date}T07:00:00`)).toISOString().slice(0, 19), elapsed_time: run.durSec, distance: Math.round(run.distKm * 1000), description }),
    });
    id = a.id;
  }
  run.stravaId = id;
  run.at = Date.now();
  return id;
}

export const activityUrl = (id) => `https://www.strava.com/activities/${id}`;
