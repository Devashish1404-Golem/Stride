// Small shared helpers: dates (local YYYY-MM-DD strings), formatting, geo.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const today = () => ymd(new Date());
export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
// Monday = 0 ... Sunday = 6
export const dow = (s) => (parseYmd(s).getDay() + 6) % 7;
export const mondayOf = (s) => addDays(s, -dow(s));

export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function fmtDate(s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return parseYmd(s).toLocaleDateString(undefined, opts);
}

export function fmtPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return '–';
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  if (s === 60) { m++; s = 0; }
  return `${m}:${pad(s)}`;
}
export function fmtDur(sec) {
  if (!isFinite(sec)) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
// "1:45:30" | "45:30" | "45" (minutes) -> seconds
export function parseDur(str) {
  if (!str) return NaN;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  if (parts.length === 1) return parts[0] * 60;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
export const fmtKm = (km) => (km >= 10 ? km.toFixed(1) : km.toFixed(2)).replace(/\.?0+$/, '') || '0';
export const round1 = (n) => Math.round(n * 10) / 10;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// metres between two [lat, lon] points
export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);
