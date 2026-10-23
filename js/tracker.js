// Guided run: GPS distance/pace, timer, step-by-step workout with voice cues.
// iOS Safari only delivers GPS while the screen is on, so we hold a screen wake lock.

import { haversine, fmtPace, uid, ymd } from './util.js';
import { ZONES } from './vdot.js';

const MAX_ACCURACY_M = 35;

export function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* voice is optional */ }
}
const say = (s) => s.replace(/(\d+):(\d\d)/g, (_, m, sec) => `${m} ${sec === '00' ? 'flat' : sec}`);
const spokenDist = (m) => (m >= 1000 ? `${+(m / 1000).toFixed(1)} kilometres` : `${m} metres`);
const spokenTime = (s) => (s >= 60 ? `${+(s / 60).toFixed(1)} minutes` : `${s} seconds`);

export class RunTracker {
  constructor(workout, paces, onUpdate) {
    this.workout = workout;
    this.paces = paces;
    this.onUpdate = onUpdate;
    this.steps = workout?.steps?.length ? [...workout.steps] : [{ label: 'Free run', zone: 'E' }];
    this.i = 0;
    this.dist = 0;           // metres
    this.elapsed = 0;        // ms, excluding pauses
    this.stepStartDist = 0;
    this.stepStartTime = 0;
    this.points = [];        // [lat, lon, t]
    this.recent = [];        // for current pace
    this.route = [];
    this.lastKm = 0;
    this.state = 'ready';
    this.gpsStatus = 'Waiting for GPS…';
  }

  get step() { return this.steps[this.i]; }
  get stepDist() { return this.dist - this.stepStartDist; }
  get stepTime() { return (this.elapsed - this.stepStartTime) / 1000; }
  get avgPace() { return this.dist > 50 ? this.elapsed / 1000 / (this.dist / 1000) : NaN; }
  get curPace() {
    const r = this.recent;
    if (r.length < 2) return NaN;
    const d = r[r.length - 1].d - r[0].d, t = (r[r.length - 1].t - r[0].t) / 1000;
    return d > 20 ? t / (d / 1000) : NaN;
  }
  stepProgress() {
    const s = this.step;
    if (s.dist) return Math.min(1, this.stepDist / s.dist);
    if (s.time) return Math.min(1, this.stepTime / s.time);
    return 0;
  }
  stepRemaining() {
    const s = this.step;
    if (s.dist) return { kind: 'dist', v: Math.max(0, s.dist - this.stepDist) };
    if (s.time) return { kind: 'time', v: Math.max(0, s.time - this.stepTime) };
    return null;
  }

  async start() {
    this.state = 'running';
    this.startedAt = new Date();
    this.tick0 = performance.now();
    this.timer = setInterval(() => this.tick(), 500);
    this.lock();
    if ('geolocation' in navigator) {
      this.watch = navigator.geolocation.watchPosition((pos) => this.onPos(pos), (err) => {
        this.gpsStatus = err.code === 1 ? 'Location permission denied. Timer only.' : 'GPS signal lost…';
        this.onUpdate();
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    } else this.gpsStatus = 'No GPS on this device. Timer only.';
    this.announceStep();
    this.onUpdate();
  }

  async lock() {
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
    this.onVis ||= () => { if (document.visibilityState === 'visible' && this.state !== 'done') this.lock(); };
    document.addEventListener('visibilitychange', this.onVis);
  }

  tick() {
    const now = performance.now();
    if (this.state === 'running') this.elapsed += now - this.tick0;
    this.tick0 = now;
    if (this.state === 'running') this.checkStep();
    this.onUpdate();
  }

  onPos(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy > MAX_ACCURACY_M) { this.gpsStatus = `Weak GPS (±${Math.round(accuracy)} m)`; return; }
    this.gpsStatus = `GPS ±${Math.round(accuracy)} m`;
    const p = [latitude, longitude, pos.timestamp];
    if (this.state !== 'running') { this.lastPt = p; return; }
    if (this.lastPt) {
      const d = haversine(this.lastPt, p);
      const dt = (p[2] - this.lastPt[2]) / 1000;
      if (d < 2 || dt <= 0) return;          // jitter while standing
      if (d / dt > 12) { this.lastPt = p; return; } // >12 m/s is a GPS jump, not running
      this.dist += d;
    }
    this.lastPt = p;
    this.recent.push({ d: this.dist, t: p[2] });
    while (this.recent.length > 2 && p[2] - this.recent[0].t > 30000) this.recent.shift();
    if (!this.route.length || p[2] - this.route[this.route.length - 1][2] > 5000) this.route.push(p);
    this.kmSplit();
    this.checkStep();
  }

  kmSplit() {
    const km = Math.floor(this.dist / 1000);
    if (km > this.lastKm) {
      this.lastKm = km;
      speak(say(`${km} kilometre${km > 1 ? 's' : ''}. Average pace ${fmtPace(this.avgPace)}.`));
    }
  }

  checkStep() {
    const s = this.step;
    if (!s || this.state !== 'running') return;
    const done = (s.dist && this.stepDist >= s.dist) || (s.time && this.stepTime >= s.time);
    if (done) this.next();
  }

  next() {
    if (this.i >= this.steps.length - 1) {
      if (this.step.dist || this.step.time) { speak('Workout complete. Great job. Keep moving to cool down, or tap finish.'); this.i = this.steps.length; this.steps.push({ label: 'Extra', zone: 'E' }); }
      this.stepStartDist = this.dist; this.stepStartTime = this.elapsed;
      return;
    }
    this.i++;
    this.stepStartDist = this.dist;
    this.stepStartTime = this.elapsed;
    this.announceStep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  announceStep() {
    const s = this.step;
    const z = this.paces[s.zone];
    const target = s.dist ? spokenDist(s.dist) : s.time ? spokenTime(s.time) : '';
    speak(say(`${s.label}. ${target} at ${ZONES[s.zone]?.name || ''} pace, ${fmtPace(z.lo)} to ${fmtPace(z.hi)}.`));
  }

  pause() { if (this.state === 'running') { this.state = 'paused'; speak('Paused'); this.onUpdate(); } }
  resume() { if (this.state === 'paused') { this.state = 'running'; this.lastPt = null; speak('Resumed'); this.onUpdate(); } }

  finish() {
    this.state = 'done';
    clearInterval(this.timer);
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    this.wakeLock?.release?.();
    document.removeEventListener('visibilitychange', this.onVis);
    speechSynthesis?.cancel?.();
    return {
      id: uid(), source: 'gps', name: this.workout?.title || 'Run',
      date: ymd(this.startedAt), startTime: this.startedAt.toISOString(),
      distKm: Math.round(this.dist / 10) / 100, durSec: Math.round(this.elapsed / 1000),
      workoutId: this.workout?.id, route: this.route.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]),
    };
  }
}
