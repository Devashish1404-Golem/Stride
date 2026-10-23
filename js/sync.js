// Device-to-device sync through your own Google Drive "app data" folder (hidden, only Stride can see it).
// Each sync: download stride.json → merge with this device → upload the merged result.

import { gfetch } from './google.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const NAME = 'stride.json';

export function snapshot(s) {
  return {
    v: 1, savedAt: Date.now(),
    profile: s.profile, plan: s.plan, planAt: s.planAt || 0,
    runs: s.runs, gymLogs: s.gymLogs, completions: s.completions,
    dismissed: s.dismissed, deleted: s.deleted || {},
    settings: s.settings, settingsAt: s.settingsAt || 0,
    integrations: s.integrations, integrationsAt: s.integrationsAt || 0,
    fitbit: { rhr: s.fitbit.rhr, sleep: s.fitbit.sleep, metrics: s.fitbit.metrics || {}, lastSync: s.fitbit.lastSync },
  };
}

const maxTs = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return out;
};

export function merge(s, r) {
  if (!r || r.v !== 1) return;
  const del = (s.deleted = maxTs(s.deleted, r.deleted));

  const union = (local, remote, prefix) => {
    const m = new Map();
    for (const x of remote || []) m.set(x.id, x);
    for (const x of local || []) { const o = m.get(x.id); if (!o || (x.at || 0) >= (o.at || 0)) m.set(x.id, x); }
    const seenExt = new Set();
    return [...m.values()]
      .filter((x) => !del[`${prefix}:${x.id}`])
      .filter((x) => !x.extId || (!seenExt.has(x.extId) && seenExt.add(x.extId)))
      .sort((a, b) => a.date.localeCompare(b.date));
  };
  s.runs = union(s.runs, r.runs, 'r');
  s.gymLogs = union(s.gymLogs, r.gymLogs, 'g');

  const comp = {};
  for (const k of new Set([...Object.keys(s.completions || {}), ...Object.keys(r.completions || {})])) {
    const a = s.completions?.[k], b = r.completions?.[k];
    const pick = !a ? b : !b ? a : (a.at || 0) >= (b.at || 0) ? a : b;
    if (pick && (pick.at || 0) >= (del[`c:${k}`] || 0)) comp[k] = pick;
  }
  s.completions = comp;

  if ((r.planAt || 0) > (s.planAt || 0) && r.profile) {
    s.profile = r.profile; s.plan = r.plan; s.planAt = r.planAt;
  }
  s.dismissed = { ...(r.dismissed || {}), ...(s.dismissed || {}) };
  if ((r.settingsAt || 0) > (s.settingsAt || 0) && r.settings) { s.settings = { ...s.settings, ...r.settings }; s.settingsAt = r.settingsAt; }
  if ((r.integrationsAt || 0) > (s.integrationsAt || 0) && r.integrations) { s.integrations = r.integrations; s.integrationsAt = r.integrationsAt; }

  const f = r.fitbit || {};
  s.fitbit.rhr = { ...(f.rhr || {}), ...s.fitbit.rhr };
  s.fitbit.sleep = { ...(f.sleep || {}), ...s.fitbit.sleep };
  s.fitbit.metrics ||= {};
  for (const [k, v] of Object.entries(f.metrics || {})) s.fitbit.metrics[k] = { ...v, ...(s.fitbit.metrics[k] || {}) };
  if (f.lastSync && (!s.fitbit.lastSync || f.lastSync > s.fitbit.lastSync)) s.fitbit.lastSync = f.lastSync;
}

async function findFile(s) {
  const q = encodeURIComponent(`name='${NAME}'`);
  const body = await (await gfetch(s, `${FILES}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`)).json();
  return body.files?.[0]?.id || null;
}

// Returns { restored: boolean } — restored = this device had no plan and the cloud did.
export async function syncNow(s) {
  const hadPlan = !!s.profile;
  let id = s.auth.driveFileId || (await findFile(s));
  if (id) {
    try {
      merge(s, await (await gfetch(s, `${FILES}/${id}?alt=media`)).json());
    } catch (e) {
      if (e.status !== 404) throw e;
      id = await findFile(s); // cached id went stale
      if (id) merge(s, await (await gfetch(s, `${FILES}/${id}?alt=media`)).json());
    }
  }
  const data = JSON.stringify(snapshot(s));
  if (id) {
    await gfetch(s, `${UPLOAD}/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: data });
  } else if (s.profile) {
    const b = `stride${Date.now()}`;
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: NAME, parents: ['appDataFolder'] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${data}\r\n--${b}--`;
    const res = await (await gfetch(s, `${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body })).json();
    id = res.id;
  }
  s.auth.driveFileId = id;
  s.auth.syncedAt = Date.now();
  s.dirtyAt = 0;
  return { restored: !hadPlan && !!s.profile };
}
