// Google sign-in (OAuth 2.0 token flow, browser-only).
// You stay signed in until you sign out: we remember your account, and when the 1-hour access
// token runs out we fetch a new one with a silent redirect (prompt=none) that needs no tapping
// as long as your Google session in this browser/app is alive.
//
// Two tokens: the Google Health API rejects tokens that carry any non-health scope
// (403 "Request contains disallowed OAuth scope(s)"), so Fitbit data uses its own health-only token.

import { GOOGLE_CLIENT_ID } from './config.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const BASE_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.appdata'];
export const HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];
const SILENT_GAP_MS = 10 * 60 * 1000;

export const redirectUri = () => location.origin + location.pathname;
export const clientId = () => GOOGLE_CLIENT_ID || localStorage.getItem('stride.clientId') || '';
export const setClientId = (id) => localStorage.setItem('stride.clientId', id.trim());
export const signedIn = (s) => !!s.auth?.email;
export const hasToken = (s) => !!(s.auth?.token && s.auth.expiresAt > Date.now());
export const healthOk = (s) => !!(s.auth?.healthToken && s.auth.healthExpiresAt > Date.now() && s.auth.healthGranted);

export function authorize(s, { health = false, silent = false } = {}) {
  const id = clientId();
  if (!id) throw new Error('Google Client ID missing');
  const st = Math.random().toString(36).slice(2);
  localStorage.setItem('stride.oauthState', JSON.stringify({ st, health, silent }));
  if (silent) localStorage.setItem(`stride.silentAt.${health ? 'h' : 'b'}`, String(Date.now()));
  const q = new URLSearchParams({
    client_id: id, redirect_uri: redirectUri(), response_type: 'token', state: st,
    scope: (health ? HEALTH_SCOPES : BASE_SCOPES).join(' '),
    include_granted_scopes: 'false',
  });
  if (s.auth?.email) q.set('login_hint', s.auth.email);
  if (silent) q.set('prompt', 'none');
  else if (!s.auth?.email) q.set('prompt', 'select_account');
  location.href = `${AUTH_URL}?${q}`;
}

// Call once at startup. Returns null if this page load isn't an OAuth return.
export async function handleRedirect(s) {
  if (!/access_token=|error=/.test(location.hash)) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('stride.oauthState') || '{}'); } catch { /* ignore */ }
  if (h.get('state') !== saved.st) return { error: 'Sign-in expired. Please try again.' };
  if (h.get('error')) {
    if (saved.silent && s.auth) { s.auth.needsTap = true; return { silentFailed: true }; }
    return { error: h.get('error') === 'access_denied' ? 'Sign-in cancelled.' : `Google sign-in failed: ${h.get('error')}` };
  }
  const granted = (h.get('scope') || '').split(' ');
  const expires = Date.now() + (Number(h.get('expires_in')) || 3600) * 1000 - 60000;
  if (saved.health) {
    s.auth = { ...(s.auth || {}), healthToken: h.get('access_token'), healthExpiresAt: expires, healthGranted: HEALTH_SCOPES.every((x) => granted.includes(x)), healthWanted: true, needsTap: false };
    return { ok: true, healthRequested: true };
  }
  const firstSignIn = !s.auth?.email;
  s.auth = { ...(s.auth || {}), token: h.get('access_token'), expiresAt: expires, needsTap: false };
  if (firstSignIn || !s.auth.name) {
    try {
      const u = await (await gfetch(s, 'https://www.googleapis.com/oauth2/v3/userinfo')).json();
      Object.assign(s.auth, { email: u.email, name: u.given_name || u.name, picture: u.picture });
    } catch (e) { return { error: `Couldn't read your Google profile: ${e.message}` }; }
  }
  return { ok: true, firstSignIn, healthRequested: !!saved.health };
}

// If signed in but a token expired, bounce through Google silently to get a fresh one.
// needs = { base, health }. Returns true when a redirect has started.
export function maybeSilentRefresh(s, needs) {
  if (!signedIn(s) || s.auth.needsTap || !navigator.onLine) return false;
  const recent = (k) => Date.now() - Number(localStorage.getItem(`stride.silentAt.${k}`) || 0) < SILENT_GAP_MS;
  if (needs.base && !hasToken(s) && !recent('b')) { authorize(s, { silent: true }); return true; }
  if (needs.health && s.auth.healthWanted && !healthOk(s) && !recent('h')) { authorize(s, { silent: true, health: true }); return true; }
  return false;
}

export function signOut(s) {
  const t = s.auth?.token;
  if (t) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
  s.auth = null;
}

export async function gfetch(s, url, opts = {}) {
  if (!hasToken(s)) throw new Error('Not signed in');
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${s.auth.token}` } });
  if (res.status === 401) { s.auth.token = null; throw new Error('Google session expired'); }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.clone().json()).error?.message || ''; } catch { /* not json */ }
    const err = new Error(`HTTP ${res.status} ${msg}`.trim());
    err.status = res.status;
    err.res = res;
    throw err;
  }
  return res;
}
