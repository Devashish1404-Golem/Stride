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
const spokenTime = (s) => (s >= 60 ? `${+(s / 60).toFixed(1)} minutes` : `${s} seconds`);
const spokenClock = (sec) => {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, !h && `${x} seconds`].filter(Boolean).join(' ');
};

export const DEFAULT_VOICE = { on: true, every: 1, time: true, pace: true, avgPace: true, alerts: true, countdown: true };

export class RunTracker {
  // opts: { unit: 'km' | 'mi', voice: DEFAULT_VOICE-like settings }
  constructor(workout, paces, onUpdate, opts = {}) {
    this.workout = workout;
    this.paces = paces;
    this.onUpdate = onUpdate;
    this.unit = opts.unit === 'mi' ? 'mi' : 'km';
    this.unitM = this.unit === 'mi' ? 1609.344 : 1000;
    this.voice = { ...DEFAULT_VOICE, ...(opts.voice || {}) };
    this.lastSplitAt = { d: 0, t: 0 };
    this.offPaceSince = 0;
    this.lastAlert = 0;
    this.cued = {};
    this.steps = workout?.steps?.length ? [...workout.steps] : [{ label: 'Free run', zone: 'E' }];
    this.i = 0;
    this.dist = 0;           // metres
    this.elapsed = 0;        // ms, excluding pauses
    this.stepStartDist = 0;
    this.stepStartTime = 0;
    this.points = [];        // [lat, lon, t]
    this.recent = [];        // for current pace
    this.route = [];
    this.lastSplit = 0;
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
  // pace in the display unit (sec per km or per mile)
  up(secPerKm) { return fmtPace(secPerKm * (this.unitM / 1000)); }
  unitWord(n) { return this.unit === 'mi' ? `mile${n === 1 ? '' : 's'}` : `kilometre${n === 1 ? '' : 's'}`; }
  spokenDist(m) {
    if (m < 1000 && this.unit === 'km') return `${Math.round(m)} metres`;
    if (m < 800 && this.unit === 'mi') return `${Math.round(m)} metres`;
    const v = +(m / this.unitM).toFixed(2);
    return `${v} ${this.unitWord(v)}`;
  }
  say(text, force = false) { if (this.voice.on || force) speak(say(text)); }

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
    if (this.state === 'running') { this.checkStep(); this.coach(); }
    this.onUpdate();
  }

  // countdowns near the end of a hard step + off-pace alerts
  coach() {
    const s = this.step;
    if (!s || !this.voice.on) return;
    const hard = !['E', 'Rec'].includes(s.zone);
    const key = `${this.i}`;
    if (this.voice.countdown && hard) {
      if (s.dist >= 400 && s.dist - this.stepDist <= 100 && !this.cued[`${key}d`]) { this.cued[`${key}d`] = 1; this.say('100 metres to go'); }
      if (s.time >= 60 && s.time - this.stepTime <= 10 && !this.cued[`${key}t`]) { this.cued[`${key}t`] = 1; this.say('10 seconds'); }
    }
    if (!this.voice.alerts || s.zone === 'Rec' || s.zone === 'R') return;
    const cp = this.curPace, z = this.paces[s.zone];
    const now = this.elapsed;
    const tooFast = cp < z.lo - (s.zone === 'E' ? 10 : 5), tooSlow = s.zone !== 'E' && cp > z.hi + 5;
    if (!isFinite(cp) || this.stepTime < 20 || !(tooFast || tooSlow)) { this.offPaceSince = 0; return; }
    if (!this.offPaceSince) this.offPaceSince = now;
    if (now - this.offPaceSince > 20000 && now - this.lastAlert > 45000) {
      this.lastAlert = now;
      this.say(`${tooFast ? 'Ease off' : 'Pick it up'}. You're at ${this.up(cp)}, target ${this.up(z.lo)} to ${this.up(z.hi)}.`);
    }
  }

  // tap-anywhere status readout
  speakStats() {
    const rem = this.stepRemaining();
    const parts = [`${this.spokenDist(this.dist)}`, `time ${spokenClock(this.elapsed / 1000)}`];
    if (isFinite(this.curPace)) parts.push(`pace ${this.up(this.curPace)}`);
    if (isFinite(this.avgPace)) parts.push(`average ${this.up(this.avgPace)}`);
    if (rem && this.steps.length > 1) parts.push(`${this.step.label}, ${rem.kind === 'dist' ? this.spokenDist(rem.v) : spokenTime(Math.round(rem.v))} left`);
    this.say(parts.join('. '), true);
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
    this.split();
    this.checkStep();
  }

  split() {
    const every = this.unitM * (this.voice.every || 1);
    const n = Math.floor(this.dist / every);
    if (n <= this.lastSplit) return;
    this.lastSplit = n;
    const splitSec = (this.elapsed - this.lastSplitAt.t) / 1000, splitM = this.dist - this.lastSplitAt.d;
    this.lastSplitAt = { d: this.dist, t: this.elapsed };
    const total = +(this.dist / this.unitM).toFixed(1);
    const parts = [`${total} ${this.unitWord(total)}`];
    if (this.voice.time) parts.push(`time ${spokenClock(this.elapsed / 1000)}`);
    if (this.voice.pace && splitM > 0) parts.push(`split pace ${this.up(splitSec / (splitM / 1000))}`);
    if (this.voice.avgPace) parts.push(`average pace ${this.up(this.avgPace)}`);
    this.say(parts.join('. '));
  }

  checkStep() {
    const s = this.step;
    if (!s || this.state !== 'running') return;
    const done = (s.dist && this.stepDist >= s.dist) || (s.time && this.stepTime >= s.time);
    if (done) this.next();
  }

  next() {
    if (this.i >= this.steps.length - 1) {
      if (this.step.dist || this.step.time) { this.say('Workout complete. Great job. Keep moving to cool down, or tap finish.'); this.i = this.steps.length; this.steps.push({ label: 'Extra', zone: 'E' }); }
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
    const target = s.dist ? this.spokenDist(s.dist) : s.time ? spokenTime(s.time) : '';
    this.say(`${s.label}. ${target ? `${target} at ` : ''}${ZONES[s.zone]?.name || ''} pace, ${this.up(z.lo)} to ${this.up(z.hi)}.`);
  }

  pause() { if (this.state === 'running') { this.state = 'paused'; this.say('Paused'); this.onUpdate(); } }
  resume() { if (this.state === 'paused') { this.state = 'running'; this.lastPt = null; this.say('Resumed'); this.onUpdate(); } }

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
      workoutId: this.workout?.id, at: Date.now(),
      // [lat, lon, seconds since start]: timestamps let Strava compute pace from the GPX
      route: this.route.map(([a, b, t]) => [+a.toFixed(5), +b.toFixed(5), Math.round((t - this.startedAt.getTime()) / 1000)]),
    };
  }
}
