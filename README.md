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

## 3. Sign in with Google (sync across devices)

**Sign in with Google** keeps you logged in until you sign out. It syncs your plan, runs, gym logs
and Fitbit data across every device you sign in on. Data is stored in a hidden Stride-only
folder in **your own Google Drive** (the app-data folder), so there's no server and no third party.

One-time Google Cloud setup (in the same project as your OAuth client):
1. **APIs & Services → Library**: enable **Google Drive API**. Also enable **Google Health API** for Fitbit.
2. **Google Auth Platform → Data Access → Add or remove scopes**, and add:
   - `https://www.googleapis.com/auth/drive.appdata`
   - the three `googlehealth.*.readonly` scopes (for Fitbit)
3. **Audience**: keep it in *Testing*, and add your Gmail under **Test users**.
4. **Clients → your Web client**:
   - Authorised JavaScript origin: `https://<you>.github.io`
   - Authorised redirect URI: `https://<you>.github.io/Stride/`
5. Put the Client ID in `js/config.js` (`GOOGLE_CLIENT_ID = '...'`) so no device ever asks for it.
   It's public by design, so it's safe to commit.

Google's browser access tokens last one hour. When one expires, Stride gets a new one with a quick
silent bounce through Google (no tapping), as long as you're still signed in to Google on that device.
It never does this during a guided run.

## 4. Connect Fitbit (Google Health API)

After signing in, tap **Settings → Connect Fitbit** and tick all the permission boxes.
The legacy Fitbit Web API switches off on **30 Oct 2026**; Stride uses its replacement, the Google Health API.

Stride syncs the last 60 days of:
- **Runs:** distance, time, avg/max heart rate, calories
- **VO₂ max** (Fitbit cardio fitness score)
- **HRV**, **resting heart rate**, **sleep**
- **SpO₂**, **breathing rate**, **skin temperature**, **steps**, **weight**

HRV, resting HR, sleep, breathing rate and skin temperature feed the daily readiness score, which can suggest
swapping a hard session for an easy one. VO₂ max trends show up as coach insights. Any data type Google doesn't
provide for your device is skipped.
It syncs again automatically when you open the app (if the last sync was over 3 hours ago).
Google's browser tokens last 1 hour, so you'll occasionally need to tap Connect again.

**If Google hasn't opened API access to your project yet** (they are onboarding developers gradually),
or something doesn't parse:
- Use **Settings → Show last raw response** to see what the API returned.
- As a fallback, request your Fitbit data export (Fitbit app → profile → *Manage data → Export your data*,
  or Google Takeout) and import the `exercise-*.json` files, or any `.gpx`/`.tcx` file, under **Settings → Import runs**.

## 5. Strava (push runs + map outlines)

1. Go to https://www.strava.com/settings/api and create an app.
   - **Website:** your app URL.
   - **Authorization Callback Domain:** `<you>.github.io` (domain only, no `https://`).
2. In **Stride → Settings → Strava**, paste the **Client ID** and **Client Secret**, then tap **Connect with Strava** and approve.

What you get:
- Runs you record in Stride upload automatically. GPS runs include the map, and the description lists the workout and your songs.
- Runs from your watch or Strava are imported, and their route outline shows in Stride.
- Strava syncs every 15 minutes while the app is open.

Strava's token exchange needs the Client Secret, and there's no way around that without a server. Stride keeps it only on your
devices and in your private Drive sync file, never in this repo.

## 6. Spotify (songs on each run)

1. Go to https://developer.spotify.com/dashboard → **Create app**.
   - Select **Web API**.
   - Redirect URI: `https://<you>.github.io/Stride/` (exactly as shown in Stride's Settings).
2. In the app's **User Management**, add the email of your Spotify account.
3. Paste the **Client ID** in **Stride → Settings → Spotify** and tap **Connect**. No secret is needed (PKCE).

What you get: a now-playing card during guided runs, and the songs played during each run (from Spotify's
last-50-plays history) saved on the run. They're also added to the Strava description.

## Voice coach

During guided runs Stride speaks over your music:
- each workout step with its target pace
- your distance, total time, split pace and average pace every 0.5 / 1 / 2 / 5 km or miles (you choose)
- "100 metres to go" and "10 seconds" countdowns on reps
- "Ease off" / "Pick it up" alerts when you've been off target pace for 20 seconds

**Tap the stats** on the run screen at any time to hear everything read out. Configure it in **Settings → Voice coach**.

## Limits worth knowing

- iOS pauses GPS, voice cues and timers for web apps when the screen locks. Stride holds a screen wake-lock during guided
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
