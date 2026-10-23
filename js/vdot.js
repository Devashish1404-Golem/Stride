// Jack Daniels' VDOT model: race-time equivalence and training paces.

const vo2AtVelocity = (v) => -4.6 + 0.182258 * v + 0.000104 * v * v; // v in m/min
const fractionOfMax = (t) => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t); // t in min

export function vdotFrom(distM, sec) {
  const t = sec / 60;
  return vo2AtVelocity(distM / t) / fractionOfMax(t);
}

function velocityAt(vo2) {
  const a = 0.000104, b = 0.182258, c = -(4.6 + vo2);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}
const secPerKm = (vMetresPerMin) => 60000 / vMetresPerMin;

export function predictTime(vdot, distM) {
  let lo = 1, hi = 1000; // minutes; vdotFrom decreases as time grows
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdotFrom(distM, mid * 60) > vdot) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}

// Estimate VDOT from a comfortable easy pace (sec/km) when no race result is known.
export function vdotFromEasyPace(paceSec) {
  const v = 60000 / paceSec;
  return vo2AtVelocity(v) / 0.67;
}

export const DISTANCES = {
  '5k': { m: 5000, label: '5K' },
  '10k': { m: 10000, label: '10K' },
  half: { m: 21097.5, label: 'Half marathon' },
  marathon: { m: 42195, label: 'Marathon' },
};

// Training paces in sec/km. Each zone has lo (faster) and hi (slower) bounds.
export function paces(vdot, goalDistM = 42195) {
  const at = (pct) => secPerKm(velocityAt(pct * vdot));
  const m = predictTime(vdot, 42195) / 42.195;
  const rp = predictTime(vdot, goalDistM) / (goalDistM / 1000);
  const t = at(0.88), i = at(0.975), r = at(1.04);
  const e = { lo: at(0.74), hi: at(0.62) };
  return {
    E: e,
    M: { lo: m - 4, hi: m + 4 },
    RP: { lo: rp - 3, hi: rp + 3 },
    T: { lo: t - 4, hi: t + 4 },
    I: { lo: i - 4, hi: i + 4 },
    R: { lo: r - 4, hi: r + 4 },
    Rec: { lo: e.hi + 10, hi: e.hi + 60 },
  };
}

export const ZONES = {
  E: { name: 'Easy', color: 'var(--z-easy)', desc: 'Conversational. You could chat in full sentences.' },
  M: { name: 'Marathon', color: 'var(--z-m)', desc: 'Goal marathon effort. Controlled, sustainable.' },
  RP: { name: 'Race pace', color: 'var(--z-m)', desc: 'Your goal race pace. Practise holding it smooth and even.' },
  T: { name: 'Threshold', color: 'var(--z-t)', desc: 'Comfortably hard. Short phrases only, about 1 hr race effort.' },
  I: { name: 'Interval', color: 'var(--z-i)', desc: 'Hard. Around 3–5K race effort.' },
  R: { name: 'Repetition', color: 'var(--z-r)', desc: 'Fast and relaxed. Focus on form.' },
  Rec: { name: 'Recovery', color: 'var(--z-rec)', desc: 'Very easy jog or walk.' },
};
