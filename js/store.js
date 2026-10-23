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
});

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const d = defaults();
    return { ...d, ...raw, fitbit: { ...d.fitbit, ...(raw.fitbit || {}) } };
  } catch {
    return defaults();
  }
}

export const state = load();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('save failed', e); }
}

export function replaceState(obj) {
  const d = defaults();
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, d, obj, { fitbit: { ...d.fitbit, ...(obj.fitbit || {}) } });
  save();
}

export function resetState() { replaceState({}); }
