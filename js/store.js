// Persistent app state in localStorage (stays on the device).

const KEY = 'stride.v1';

const defaults = () => ({
  profile: null,
  plan: null,
  runs: [],        // { id, date, startTime, distKm, durSec, avgHr, source, workoutId, rpe, name, route }
  gymLogs: [],     // { id, date, workoutId, sessionKey, title, entries: [{ ex, sets: [{ kg, reps, done }] }] }
  completions: {}, // workoutId -> { status: 'done' | 'skipped', runId?, logId? }
  fitbit: { clientId: '', tokens: null, lastSync: null, rhr: {}, sleep: {}, error: null },
  dismissed: {},   // insight id -> date dismissed
  deleted: {},     // sync tombstones: 'r:<runId>' | 'g:<logId>' | 'c:<workoutId>' -> timestamp
  planAt: 0,       // when profile/plan last changed (sync picks the newest)
  dirtyAt: 0,      // unsynced local change
  auth: null,      // Google account: { email, name, picture, token, expiresAt, healthGranted, ... }
  settings: { units: 'km', tiles: DEFAULT_TILES, voice: {} },
  settingsAt: 0,
  integrations: { strava: { autoPush: true }, spotify: { clientId: '' } },
  integrationsAt: 0,
});

export const DEFAULT_TILES = ['hrv', 'rhr', 'vo2max', 'sleep', 'resp', 'spo2', 'skinTemp', 'steps'];

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const d = defaults();
    return {
      ...d, ...raw,
      fitbit: { ...d.fitbit, ...(raw.fitbit || {}) },
      settings: { ...d.settings, ...(raw.settings || {}) },
      integrations: { strava: { ...d.integrations.strava, ...(raw.integrations?.strava || {}) }, spotify: { ...d.integrations.spotify, ...(raw.integrations?.spotify || {}) } },
    };
  } catch {
    return defaults();
  }
}

export const state = load();

const listeners = [];
export const onChange = (fn) => listeners.push(fn);

// quiet = internal bookkeeping (e.g. after a sync) that shouldn't trigger another sync
export function save(quiet = false) {
  if (!quiet) state.dirtyAt = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('save failed', e); }
  if (!quiet) listeners.forEach((fn) => fn());
}

export const tombstone = (key) => { state.deleted[key] = Date.now(); };

export function replaceState(obj, keepAuth = true) {
  const d = defaults();
  const auth = keepAuth ? state.auth : null;
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, d, obj, { auth, planAt: Date.now(), fitbit: { ...d.fitbit, ...(obj.fitbit || {}) } });
  save();
}

export function resetState() { replaceState({}, false); }
