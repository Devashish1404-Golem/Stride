// Spotify: what's playing during a run, and the songs you listened to on each run.
// Uses Authorization Code + PKCE, so only a Client ID is needed (no secret). Tokens live on this device.

const KEY = 'stride.spotify';
const SCOPES = 'user-read-recently-played user-read-currently-playing';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const store = (t) => localStorage.setItem(KEY, JSON.stringify(t));

export const clientIdOf = (s) => s.integrations?.spotify?.clientId || '';
export const connected = () => !!load()?.refresh_token;

export async function connect(s, redirectUri) {
  const id = clientIdOf(s);
  if (!id) throw new Error('Enter your Spotify Client ID first.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = Math.random().toString(36).slice(2);
  localStorage.setItem('stride.codeFlow', JSON.stringify({ provider: 'spotify', st, verifier }));
  const q = new URLSearchParams({ client_id: id, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, state: st, code_challenge_method: 'S256', code_challenge: challenge });
  location.href = `https://accounts.spotify.com/authorize?${q}`;
}

async function tokenReq(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify: ${body.error_description || body.error || res.status}`);
  const prev = load() || {};
  const t = { access_token: body.access_token, refresh_token: body.refresh_token || prev.refresh_token, expires_at: Date.now() + body.expires_in * 1000 - 60000 };
  store(t);
  return t;
}

export async function finishConnect(s, code, verifier, redirectUri) {
  await tokenReq({ client_id: clientIdOf(s), grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
}

export function disconnect() { localStorage.removeItem(KEY); }

async function api(s, path) {
  let t = load();
  if (!t) throw new Error('Spotify not connected');
  if (t.expires_at < Date.now()) t = await tokenReq({ client_id: clientIdOf(s), grant_type: 'refresh_token', refresh_token: t.refresh_token });
  const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (res.status === 204) return null;
  if (res.status === 401) { store({ ...t, expires_at: 0 }); throw new Error('Spotify session expired'); }
  if (!res.ok) throw new Error(`Spotify ${res.status}`);
  return res.json();
}

const track = (t) => ({ name: t.name, artist: t.artists?.map((a) => a.name).join(', '), url: t.external_urls?.spotify, img: t.album?.images?.at(-1)?.url, ms: t.duration_ms });

export async function nowPlaying(s) {
  const b = await api(s, '/me/player/currently-playing');
  return b?.item ? { ...track(b.item), playing: b.is_playing } : null;
}

// Songs played between the run's start and end (Spotify keeps your last 50 plays).
export async function songsForRun(s, run) {
  if (!run.startTime || !run.durSec) return [];
  const start = Date.parse(run.startTime), end = start + run.durSec * 1000 + 3 * 60000;
  const b = await api(s, `/me/player/recently-played?limit=50&after=${start - 10 * 60000}`);
  return (b?.items || [])
    .filter((i) => { const t = Date.parse(i.played_at); return t >= start + 30000 && t <= end; })
    .map((i) => ({ ...track(i.track), at: i.played_at }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
