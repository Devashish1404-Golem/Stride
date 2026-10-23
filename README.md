# Stride: Run & Gym Coach

A Runna-style training app for your iPhone. It's a Progressive Web App: you host it from your Mac,
open it in Safari, tap **Add to Home Screen**, and it runs full-screen like a native app.
Your data stays on the phone.

## What it does

- **Personalised plan** (5K / 10K / Half / Marathon): periodised base → build → peak → taper,
  a recovery week every 4th week, and a long-run progression up to 32 km for the marathon.
- **Paces calibrated to you**: from a recent race or your easy pace, using Jack Daniels' VDOT model.
  Easy, marathon, threshold, interval and repetition zones.
- **Structured workouts**: warm-up, reps, recoveries, cool-down, plus why each session matters.
  Sessions include intervals, tempo, cruise intervals, hills, marathon-pace runs and fast-finish long runs.
- **Guided GPS runs**: live pace, step-by-step targets, voice cues for every step and kilometre,
  and "Ease off / Pick it up / On pace" feedback.
- **Integrated gym plan**: runner-specific strength sessions that follow the running phases
  (capacity → heavy + plyometrics → maintenance → mobility). The day before a long run is kept light.
  Set logging, plus progressive-overload weight suggestions.
- **Adaptive coach**:
  - spots load spikes (acute:chronic ratio)
  - suggests reducing the plan when you're missing sessions
  - offers to update your paces when a hard run shows you're fitter
  - flags easy runs run too fast
  - suggests swapping today's session when your Fitbit resting HR or sleep shows poor recovery
  - tracks your goal time
- **Fitbit data** through the Google Health API, plus **GPX/TCX** and **Fitbit data-export** import.

## 1. Host it (pick one)

GPS and Google sign-in on an iPhone need **HTTPS**, so use free static hosting.

**GitHub Pages (recommended)**
```bash
cd stride
git init && git add . && git commit -m "Stride"
gh repo create stride --public --source=. --push   # or create the repo on github.com and push
gh api -X POST repos/{owner}/stride/pages -f "source[branch]=main" -f "source[path]=/"
```
Your app is then at `https://<your-username>.github.io/stride/`.

**Netlify Drop**: drag the `stride` folder onto https://app.netlify.com/drop. You get an HTTPS URL instantly.

**Just testing on the Mac**: `cd stride && python3 -m http.server 8000`, then open http://localhost:8000.
Opening that URL from the iPhone over Wi-Fi is plain `http`, so GPS and Fitbit sign-in are blocked there.

## 2. Install on your iPhone

1. Open your HTTPS URL in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open Stride from the Home Screen and create your plan.

iOS keeps the Home Screen app's storage separate from Safari's, so set up and connect Fitbit
from inside the installed app.

## 3. Connect Fitbit (Google Health API)

Google is retiring the legacy Fitbit Web API (it switches off on **30 Oct 2026**). Fitbit data now
comes through the **Google Health API**, which needs a one-time Google Cloud setup:

1. Go to https://console.cloud.google.com, create a project, then open **APIs & Services → Library**
   and enable **Google Health API**.
2. Open **OAuth consent screen**:
   - choose External, in Testing mode
   - add your own Google account (the one your Fitbit uses) as a **test user**
   - add the scopes `googlehealth.activity_and_fitness.readonly`,
     `googlehealth.health_metrics_and_measurements.readonly` and `googlehealth.sleep.readonly`
3. Open **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorised JavaScript origin: `https://<your-username>.github.io`
   - Authorised redirect URI: exactly what Stride shows under Settings, e.g. `https://<your-username>.github.io/stride/`
4. Copy the Client ID into **Stride → Settings → Fitbit via Google Health**, then tap **Connect**.

Stride syncs runs (distance, time, avg HR), resting heart rate and sleep for the last 60 days.
It syncs again automatically when you open the app (if the last sync was over 3 hours ago).
Google's browser tokens last 1 hour, so you'll occasionally need to tap Connect again.

**If Google hasn't opened API access to your project yet** (they are onboarding developers gradually),
or something doesn't parse:
- Use **Settings → Show last raw response** to see what the API returned.
- As a fallback, request your Fitbit data export (Fitbit app → profile → *Manage data → Export your data*,
  or Google Takeout) and import the `exercise-*.json` files, or any `.gpx`/`.tcx` file, under **Settings → Import runs**.

## Limits worth knowing

- iOS pauses GPS for web apps when the screen locks. Stride holds a screen wake-lock during guided
  runs, so keep the app open. For locked-screen tracking, record with your Fitbit and let it sync.
- Data lives on the device. Use **Settings → Backup → Export** regularly.

## Project layout

```
index.html, styles.css, manifest.webmanifest, sw.js (offline), icons/
js/app.js      UI, views, actions
js/plan.js     plan generator (periodisation, workouts, scheduling)
js/vdot.js     VDOT fitness model, race predictions, pace zones
js/coach.js    adaptive insights + readiness
js/gym.js      strength library, phase templates, load progression
js/health.js   Google Health API (Fitbit) sync + GPX/TCX/Fitbit-export import
js/tracker.js  GPS guided-run engine with voice cues
js/store.js    localStorage persistence
```
No build step and no dependencies: edit a file, redeploy, done.
