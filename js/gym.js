// Strength training for runners: exercise library, phase-aware sessions, progression.

export const EXERCISES = {
  squat: { name: 'Back Squat', group: 'legs', inc: 2.5, cue: 'Brace, sit between the hips, drive up through mid-foot.' },
  goblet: { name: 'Goblet Squat', group: 'legs', inc: 2, cue: 'Elbows inside knees, chest tall.' },
  rdl: { name: 'Romanian Deadlift', group: 'posterior', inc: 2.5, cue: 'Hinge, soft knees, bar close to the legs.' },
  deadlift: { name: 'Trap-bar Deadlift', group: 'posterior', inc: 5, cue: 'Push the floor away, lock out with glutes.' },
  bss: { name: 'Bulgarian Split Squat', group: 'legs', inc: 2, cue: 'Front shin vertical-ish, control the descent. Reps per leg.' },
  stepup: { name: 'Weighted Step-up', group: 'legs', inc: 2, cue: 'Drive through the top leg, no push from the back foot. Reps per leg.' },
  hipthrust: { name: 'Hip Thrust', group: 'posterior', inc: 5, cue: 'Chin tucked, ribs down, squeeze at the top.' },
  sllr: { name: 'Single-leg RDL', group: 'posterior', inc: 2, cue: 'Square hips, reach long. Reps per leg.' },
  calf: { name: 'Standing Calf Raise', group: 'calves', inc: 2.5, cue: 'Full range, 2 s up, 3 s down.' },
  soleus: { name: 'Bent-knee Calf Raise', group: 'calves', inc: 2.5, cue: 'Knees bent ~30°, targets soleus.' },
  pogo: { name: 'Pogo Jumps', group: 'plyo', bodyweight: true, cue: 'Stiff ankles, quick contacts.' },
  boxjump: { name: 'Box Jump', group: 'plyo', bodyweight: true, cue: 'Land soft and quiet, step down.' },
  bound: { name: 'Bounding', group: 'plyo', bodyweight: true, cue: 'Exaggerated running stride, 20 m.' },
  pullup: { name: 'Pull-up / Lat Pulldown', group: 'upper', inc: 2.5, cue: 'Full hang to chin over bar.' },
  row: { name: 'Dumbbell Row', group: 'upper', inc: 2, cue: 'Pull to hip, pause.' },
  pushup: { name: 'Push-up', group: 'upper', bodyweight: true, cue: 'Rigid plank, chest to fist height.' },
  press: { name: 'Overhead Press', group: 'upper', inc: 2.5, cue: 'Glutes tight, press in a straight line.' },
  plank: { name: 'Plank', group: 'core', bodyweight: true, unit: 's', cue: 'Ribs down, squeeze glutes.' },
  sideplank: { name: 'Side Plank', group: 'core', bodyweight: true, unit: 's', cue: 'Hips high, per side.' },
  deadbug: { name: 'Dead Bug', group: 'core', bodyweight: true, cue: 'Low back pressed down. Reps per side.' },
  pallof: { name: 'Pallof Press', group: 'core', inc: 1, cue: 'Resist rotation, press out and hold 2 s.' },
  copenhagen: { name: 'Copenhagen Plank', group: 'core', bodyweight: true, unit: 's', cue: 'Adductor strength, per side.' },
  hipairplane: { name: 'Hip Airplanes', group: 'mobility', bodyweight: true, cue: 'Slow controlled rotation, per side.' },
  worldsgreatest: { name: "World's Greatest Stretch", group: 'mobility', bodyweight: true, cue: 'Lunge, elbow to instep, rotate. Per side.' },
  ninety: { name: '90/90 Hip Switches', group: 'mobility', bodyweight: true, cue: 'Tall spine, slow transitions.' },
  ankle: { name: 'Knee-to-wall Ankle Mobilisation', group: 'mobility', bodyweight: true, cue: 'Heel down, knee tracks over toes. Per side.' },
  glutebridge: { name: 'Single-leg Glute Bridge', group: 'posterior', bodyweight: true, cue: 'Per side, hold 2 s at top.' },
};

const it = (ex, sets, reps, rest = 90) => ({ ex, sets, reps, rest });

// Phase-dependent prescriptions. Base builds capacity, build gets heavy + plyometric,
// peak maintains with low volume, taper is mobility only.
const TEMPLATES = {
  base: {
    A: { title: 'Strength A: Legs & Core', items: [it('goblet', 3, 10), it('rdl', 3, 10), it('bss', 3, 8), it('calf', 3, 15, 60), it('deadbug', 3, 10, 45), it('sideplank', 2, 30, 45)] },
    B: { title: 'Strength B: Posterior & Upper', items: [it('hipthrust', 3, 10), it('stepup', 3, 8), it('row', 3, 10), it('pushup', 3, 12, 60), it('soleus', 3, 15, 60), it('plank', 3, 40, 45)] },
  },
  build: {
    A: { title: 'Strength A: Heavy Legs + Plyo', items: [it('pogo', 3, 20, 60), it('squat', 4, 5, 150), it('rdl', 3, 6, 120), it('bss', 3, 6), it('calf', 3, 10, 60), it('pallof', 3, 10, 45)] },
    B: { title: 'Strength B: Power & Posterior', items: [it('boxjump', 3, 5, 90), it('deadlift', 4, 5, 150), it('stepup', 3, 6), it('pullup', 3, 6), it('soleus', 3, 12, 60), it('copenhagen', 2, 20, 45)] },
  },
  peak: {
    A: { title: 'Maintenance A: Legs', items: [it('pogo', 2, 15, 60), it('squat', 2, 5, 150), it('sllr', 2, 6), it('calf', 2, 10, 60), it('deadbug', 2, 10, 45)] },
    B: { title: 'Maintenance B: Posterior', items: [it('deadlift', 2, 4, 150), it('stepup', 2, 6), it('pullup', 2, 6), it('soleus', 2, 12, 60), it('sideplank', 2, 30, 45)] },
  },
  mobility: {
    A: { title: 'Mobility & Activation', items: [it('worldsgreatest', 2, 5, 20), it('ninety', 2, 8, 20), it('ankle', 2, 10, 20), it('hipairplane', 2, 5, 20), it('glutebridge', 2, 10, 30), it('deadbug', 2, 8, 30)] },
  },
};
TEMPLATES.mobility.B = TEMPLATES.mobility.A;

export function gymSession(phase, variant, light = false) {
  const key = light || phase === 'taper' ? 'mobility' : phase;
  const tpl = TEMPLATES[key][variant];
  return { sessionKey: `${key}.${variant}`, title: tpl.title, items: tpl.items };
}
export const sessionByKey = (k) => {
  const [p, v] = k.split('.');
  const t = TEMPLATES[p]?.[v];
  return t ? { sessionKey: k, title: t.title, items: t.items } : null;
};
export const allSessions = () => Object.entries(TEMPLATES).flatMap(([p, vs]) =>
  (p === 'mobility' ? ['A'] : ['A', 'B']).map((v) => ({ sessionKey: `${p}.${v}`, phase: p, title: vs[v].title })));

// Suggest the next load for an exercise from its most recent log.
export function suggestLoad(gymLogs, exKey, targetReps) {
  const ex = EXERCISES[exKey];
  if (!ex || ex.bodyweight) return null;
  for (let i = gymLogs.length - 1; i >= 0; i--) {
    const entry = gymLogs[i].entries.find((e) => e.ex === exKey);
    if (!entry) continue;
    const done = entry.sets.filter((s) => s.done && s.kg > 0);
    if (!done.length) continue;
    const top = Math.max(...done.map((s) => s.kg));
    const allHit = entry.sets.every((s) => s.done && s.reps >= targetReps);
    return allHit
      ? { kg: top + ex.inc, why: `Hit all reps last time at ${top} kg, so add ${ex.inc} kg` }
      : { kg: top, why: `Repeat ${top} kg and aim to complete every rep` };
  }
  return null;
}
