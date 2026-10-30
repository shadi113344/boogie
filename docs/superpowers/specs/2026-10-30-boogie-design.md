# Boogie: design

Date: 2026-10-30. Author: Claude, from a design conversation with Shadi. Decisions marked **[Shadi]** are his; decisions marked **[Claude]** are calls I made and he can veto.

## 1. Intent

Boogie is a skydiving simulator for people who actually jump. Shadi's friends jump all over the world (Egypt, Dubai, Spain, Sweden, the UK, Switzerland) and he wants to send them a link that makes them lean in and say "that is exactly what it's like". The previous attempt (a single-file arcade game, kept under `legacy/`) failed that test: cartoon physics, pull altitudes a licensed jumper would be grounded for, gold rings, a boost tank and coins.

The first version is the feedback version. If the friends love it, it grows: a second version with tandem and BASE, a third with multiplayer, and a real Android and iOS app built from the same code. **[Shadi]**

Success for version one: a skydiver plays a full jump on their phone and recognises every step, the numbers on the altimeter, the feel of the opening, the silence under canopy, the landing they would have been proud of or the low turn their instructor would have shouted about. The non-skydiver who opens the same link is taught by the game itself.

## 2. Goals, non-goals, anti-goals

### Goals (version one)

1. A complete jump as a skydiver experiences it: manifest, gear, climb, jump run and spot, exit, freefall, wave-off and pull, opening, canopy check, pattern, flare, landing, debrief and logbook.
2. Real physics with real numbers (section 7), verified by automated tests against the target tables.
3. Real places: any drop zone on Earth from real elevation and satellite imagery, with six preloaded (section 6).
4. First-person by default, third-person on demand and for the replay. **[Shadi]**
5. Three kits: plain jumpsuit (belly flying), tracking suit, wingsuit as the finale. **[Shadi]**
6. An AI guide who exits with you, flies alongside, gives the real hand signals and tracks off at break-off. **[Shadi]**
7. Phone-first, portrait, touch and tilt controls, with desktop keyboard and mouse as the 10 percent case. **[Shadi: 90 percent phone]**
8. A shareable debrief card (image) so a good jump travels through WhatsApp.
9. Hosted on GitHub Pages, installable as a PWA, offline-capable for a drop zone you have loaded once.
10. Architecture that carries into version two and three and into a Capacitor app without a rewrite.

### Non-goals (version one)

Tandem, BASE, freeflying (sit and head-down), multiplayer, accounts and cloud sync, monetisation, a custom domain, store listings. All are planned later (section 12) and the architecture must not block them.

### Anti-goals (things that would make this a failure even if it works)

- Rings, pickups, boost, coins, rarity tiers, experience points or any arcade reward layer.
- Auto-steer, auto-aim or assisted flying that the player did not switch on.
- Flare or pull as timed button presses. Every outcome must come from the physics.
- Altitudes or speeds a skydiver would recognise as wrong: a pull window at 2,000 ft, a belly flyer gliding like a wingsuit, a canopy doing 34 mph.
- Speeding physics up to shorten a phase. An explicit "skip the climb" button is fine; a canopy ride that secretly runs at 1.5x is not.
- A floating HUD in first-person beyond what a real instrument shows. The altimeter is on the wrist.
- A character that looks like a blob. If a model cannot be made convincing, the first-person view hides it and the third-person model gets the effort.

## 3. Players and devices

- Primary: iPhone (Safari) and Android (Chrome) from roughly 2020 onward, portrait, held in two hands. Landscape must work but is not the design target.
- Secondary: desktop browser with keyboard and mouse.
- Performance targets: 60 fps on an iPhone 12-class or 2021 mid-range Android, never below 30 fps on anything from 2019. Budgets: under 300 draw calls per frame, under 1.5 million visible triangles, under 300 MB GPU texture memory, under 4 MB of JavaScript, first jump playable within 20 seconds on 4G including the drop-zone tile prefetch.
- Device sensors: tilt via DeviceOrientation (iOS asks permission on a user gesture and requires HTTPS, which GitHub Pages provides). Haptics via the Vibration API where available.
- Audio starts only after a user gesture (iOS rule), so the manifest screen's "board" button is the gesture.
- Test devices: Shadi has an iPhone, an Android phone and a Windows desktop, and will do a short pass on both phones at the end of every milestone. Development happens on Windows; the phones reach the dev server over the local network with a self-signed certificate (tilt and audio need HTTPS), and the deployed page for everything else. **[Shadi]**

## 4. How it gets made **[Claude]**

Shadi handed me the technical choices.

- **Stack:** Vite, TypeScript, three.js (WebGL2). Vanilla TypeScript for UI with HTML templates and a tiny reactive store, no UI framework, to keep the surface small for a delegated implementer. Vitest for unit tests. Playwright for a smoke test of boot and a scripted jump.
- **Hosting:** GitHub Pages from a GitHub Actions workflow on every push to `main`, in a **public** repository under Shadi's GitHub account (the free plan serves Pages only from public repositories; the code can go private later when the app moves to a paid host). **[Shadi: "put it online for me"; public repo chosen 2026-10-30]**
- **App shell later:** Capacitor. Consequences now: no browser-only APIs that break inside a WebView, no popups, storage in IndexedDB and Cache Storage, sensors through standard web APIs with a thin adapter so Capacitor plugins can replace them.
- **Who writes the code:** MiniMax is the implementer for every task. Claude writes this design, the plan, each task brief, reviews every diff, runs the tests and lands on `main`. If a task bounces twice, Claude finishes it and says so. **[Shadi: "use minimax for doing all the coding"]**
- **How MiniMax is run:** as a full agentic coding harness, not a prompt-in, code-out call. The `claude` command-line tool is pointed at MiniMax's Anthropic-compatible endpoint (model `MiniMax-M3`, about 200k context) with its own config directory and MCP servers disabled, started inside a git worktree for the task with edit permissions. It can read the repository, edit files, run Vitest and iterate on failures before it reports. The key is read from Shadi's key file at launch and never written anywhere. One worktree per task, one task at a time per set of files. Tasks are sized to fit one context: a brief, the files to touch, the tests that must pass, what to leave alone. The pieces the reviewer expects to bounce (terrain streaming, the opening sequence, the attitude controller) get the most detailed briefs and reference pseudocode in the plan, and MiniMax still goes first.
- **Branch and repository:** default branch `main`; repository named `boogie`; the old game moves to `legacy/` in the first commit of the scaffold.
- **Repository layout:**
  - `src/sim/` pure simulation, no DOM, no three.js, deterministic, seeded, fixed timestep.
  - `src/world/` real-world data: tile math, elevation and imagery providers, caching, prefetch.
  - `src/render/` three.js scene, terrain mesh streaming, sky, jumper, canopy, aircraft, cameras, effects.
  - `src/audio/` procedural wind and sampled sounds.
  - `src/ui/` screens, in-flight controls, settings, logbook, share card.
  - `src/data/` drop zones, gear tables, audible presets.
  - `assets/` glTF models (Draco), textures (KTX2), sounds.
  - `tests/` Vitest suites, including the physics target tables.
  - `docs/superpowers/specs/` this document and its successors.
  - `legacy/` the old single-file game, kept for reference only.

## 5. The jump, step by step

This is the spine of the product. Every screen serves one of these steps.

1. **Manifest.** Home screen. Pick the drop zone (preloaded list or search), see today's conditions (surface wind and direction, winds aloft, cloud base, temperature, sun), pick the kit (jumpsuit, tracking suit, wingsuit), the canopy, the pull altitude (default 3,500 ft; 2,500 to 5,500), the audible altimeter settings, and whether the guide jumps with you. "Manifest on load 3." The logbook lives here too, and so does the jumper's profile: body weight, declared licence (student, A, B, C, D) and declared jump numbers, which a real manifest would also ask for. "Today's conditions" are real when online: current surface wind and gusts, winds aloft at the standard pressure levels, cloud cover and an estimated base, temperature, all from Open-Meteo (free, no key), cached for offline use and shown with the fetch time. The presets in section 6 are an override ("make it sporty") and the offline fallback. **[Claude]**
2. **Boarding and climb.** Gear check overlay (handles, chest strap, three rings, pin check as a tap-through that teaches non-jumpers). The climb is compressed to about 60 seconds with the view out the door, altimeter winding up, engine note, cold light at altitude. A "skip to jump run" button is always there.
3. **Jump run.** The aircraft flies the run into wind at exit altitude. Door opens, light goes red then green. A spotting view looks straight down past the door. The ideal exit point is upwind of the landing area by the drift the winds will give you in freefall and under canopy, and the game computes it; the player decides when to go. The guide says "good spot" or "give it five seconds" if enabled. Climb out and exit on a swipe.
4. **Freefall.** The hill: relative wind from the front at aircraft speed, rotating to vertical as you accelerate to terminal over ten to twelve seconds. Then flying: turns, forward and backward drive, fall rate, tracking. The guide docks, flies in front, gives signals (arch, legs out, relax, check altitude, pull). Audible beeps at the set altitudes. Break-off: the guide turns and tracks away, you track, wave off.
5. **Pull.** Swipe the hackey at the right hip. Pilot chute, bridle, bag, line stretch, snivel, inflation, slider down: three to five seconds of real deceleration, with the sound going from roar to flutter to snap to silence.
6. **Canopy.** Look up (tilt the phone back): square, stable, steerable. Unstow the brakes, controllability check. Find the landing area and the windsock. Fly the holding area, then the pattern: downwind at 1,000 ft, base at 600, final at 300, into wind. Two-stage flare from about 12 ft. Land, stand it up, or PLF.
7. **Debrief and logbook.** The numbers (section 11), a third-person replay with a scrub bar, the ground track on the satellite image, the pattern altitude graph, the flags (low turn, late pull, downwind landing, long spot), and a share card.

Malfunctions happen (section 7.5). The sequence includes cutaway and reserve when they do.

## 6. The world: real places

### Drop zones

A drop zone is data: name, country, landing-area centre (latitude, longitude), landing-area polygon, hazards (runway, hangar footprint, roads, water, trees), typical jump-run heading, exit altitude, aircraft type, units convention, time zone. Any latitude and longitude works; the preloaded six get hand-checked polygons and hazards. Coordinates below are approximate; the builder verifies each against the imagery and places the landing area on the real grass. **[Claude picked the specific DZs for Shadi's six countries]**

| Drop zone | Country | Approximate centre | Notes |
|---|---|---|---|
| Skydive Egypt, Sharm El Sheikh | Egypt | 27.98 N, 34.39 E | desert and sea, Caravan |
| Skydive Dubai, Palm DZ | UAE | 25.09 N, 55.14 E | water on three sides, landing beside the Palm; water is a hazard |
| Empuriabrava | Spain | 42.26 N, 3.11 E | the famous one, sea, canals, Pyrenees behind |
| Skydive Stockholm, Gryttjom | Sweden | 60.30 N, 17.43 E | forest everywhere, grass strip; off-landing means trees |
| Hinton Skydiving Centre, Hinton-in-the-Hedges | UK | 52.03 N, 1.21 W | hedgerows, a disused airfield, often windy |
| Skydive Switzerland, Interlaken | Switzerland | 46.68 N, 7.88 E | two lakes, the Eiger wall, the one that sells the idea on sight |

Interlaken and Dubai get polished first because they prove "jump anywhere" at a glance. Search for anywhere else uses a free geocoder (Nominatim, rate-limited and attributed) and drops a default 100 m landing circle at the chosen point, with no hazards. Every drop zone screen has an "adjust landing area" mode: drag the circle on the satellite image, resize it, mark water and the runway. That is how the preloaded six get confirmed by the friends who jump there (they know which field is the landing area at Gryttjom; a map does not), and how a searched-for place becomes a proper drop zone. Confirmed polygons are copied back into `src/data/` by hand. Display units (feet and mph, or metres and km/h) are a per-player setting defaulting to the drop zone's convention: metres at Gryttjom, Interlaken and Empuriabrava, feet elsewhere. Lauterbrunnen's cliffs, next to Interlaken, are the first BASE site in version two. **[Claude]**

### Data sources and licensing **[Claude]**

- **Elevation:** AWS Terrain Tiles (Mapzen Terrarium PNG), free, no key, CORS enabled: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, height = R × 256 + G + B / 256 − 32768 metres. Zoom 14 within 10 km of the landing area, zoom 12 to 60 km, zoom 9 beyond.
- **Imagery, near and mid field:** Esri World Imagery tiles, `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`, with the required attribution ("Esri, Maxar, Earthstar Geographics, and the GIS User Community") visible on the manifest screen and the share card. This endpoint is widely used without a key but Esri's terms expect an API key for production apps. Acceptable for the feedback version; the store version must move to a licensed provider (MapTiler Satellite or Mapbox Satellite) or an ArcGIS key. The provider is a URL template in config so the swap is one line.
- **Imagery, far field and fallback:** EOX Sentinel-2 cloudless (10 m per pixel, CC BY-NC-SA 4.0, non-commercial), fine beyond 30 km and as a fallback when Esri is unavailable.
- **Geocoding:** Nominatim with the mandated user agent and one request per second.
- **Offline:** everything a drop zone needs is prefetched on "manifest" with a progress bar and stored in Cache Storage, so a loaded DZ works on a plane.

### Terrain representation **[Claude]**

- A local tangent plane in metres at the landing area (east, up, north). Web Mercator tiles map onto it with the latitude scale factor. Earth curvature is applied as a vertical drop of d² / (2R), which matters from 13,500 ft where the horizon is about 230 km away.
- A quadtree of terrain tiles, each a heightmap mesh (128 × 128 vertices near the landing area, 64 mid, 32 far) textured with the imagery tile of matching zoom, selected by screen-space error, geomorphed between levels so nothing pops, with skirts to hide cracks.
- Imagery zoom by distance from the landing area: 18 within 1.5 km (and along the final approach corridor), 17 within 4 km, 16 within 10 km, 14 within 30 km, 12 to 100 km, 9 to the horizon. That is roughly 400 tiles at zoom 18, about 8 MB, and under 40 MB for a whole drop zone.
- Floating origin: the scene is rebased around the camera every few hundred metres so float precision never jitters.
- Sampling: the simulation reads ground height from the elevation quadtree, bilinear, never from the render mesh.
- Rendering tricks that help: anisotropic filtering, a subtle normal-map detail texture that fades in below 500 ft (grass, scrub, sand by land class guessed from imagery colour) so the ground does not look like a photograph pasted on a sheet in the last seconds, and the jumper's shadow projected onto the terrain near the ground.

### Sky, atmosphere, weather **[Claude]**

- Sun position computed from the drop zone's latitude, longitude, date and the chosen time of day (default 10:00 local, summer). Physically based sky (Hosek-Wilkie or Preetham) and aerial perspective: distance haze tinted by the sky, stronger near the horizon and in humid places, with a ground haze layer in the lowest 1,500 ft. Atmosphere colour changes as you fall; the horizon is far and blue at exit and close and warm on final.
- Clouds: scattered cumulus at a selectable base (default 5,000 ft, option "none" and "broken") rendered as soft billboards with depth fade. Falling past a cloud is a moment to keep. Cloud shadows on the ground if the budget allows.
- Wind: a profile with surface speed and direction, veering and strengthening with altitude (typical winds aloft two to three times the surface wind, backed or veered 20 to 40 degrees), gusts as low-pass filtered noise, and mechanical turbulence in the lowest 300 ft downwind of hangars and tree lines. Presets: calm, typical, sporty, random. Everything downstream (the spot, the drift, the pattern, the landing ground speed) comes from this one profile.
- A windsock at the landing area that actually reads the surface wind, and ground-wind indicators (smoke, flags) where the drop zone has them.

## 7. Physics

The simulation is a pure module, fixed timestep at 120 Hz, semi-implicit Euler, seeded pseudo-random numbers, no dependency on the renderer. Input is sampled into a log so a jump can be replayed exactly (replay, debrief, future multiplayer). Air density follows the International Standard Atmosphere from the drop zone's elevation and temperature, so true airspeeds are higher at altitude than the sea-level numbers skydivers quote. All forces are computed as ½ ρ V² C A.

Default jumper: 85 kg plus 12 kg of gear, adjustable from 55 to 110 kg body mass in settings. Heavier jumpers fall faster and load their canopies more; this must fall out of the model, not be a lookup.

### 7.1 Freefall body model

One model covers belly, tracking and wingsuit: the body is a lifting plate with a polar (lift and drag coefficients against angle of attack) and a reference area that depend on the kit and the body position. The player's inputs do not set a flight path; they set a body attitude relative to the relative wind, and the attitude slews with realistic rates and lag. Forces follow from attitude and airspeed. This is the opposite of the old game, and it is non-negotiable.

- **Attitude controller.** Inputs command target pitch and bank of the body plane relative to the relative wind, and a body-twist (yaw) rate for belly turns. The attitude moves toward the target with a first-order lag of about 0.3 s and rate limits (belly turns up to 150 degrees per second at full input, roll and pitch up to 90 degrees per second). Beyond the stability envelope (roughly 70 degrees of pitch or bank in a belly position without a deliberate transition) the body tumbles: attitude drifts randomly, drag drops, speed climbs. Arching (fall-rate input fully toward "fast") recovers within about two seconds. Tumbling off the exit if you do not present to the relative wind is expected and recoverable.
- **The hill.** At exit the relative wind is horizontal at aircraft speed (about 95 kt true at 13,500 ft) and rotates to vertical as the jumper accelerates; the body holds attitude relative to the relative wind, so "presenting to the hill" is natural and a poor exit tumbles. Terminal is reached in 10 to 12 seconds and the first 1,000 ft takes about 10 seconds, after which 1,000 ft takes about 5.5 seconds at 120 mph.
- **Wind.** The wind vector from the profile is added to air velocity everywhere; gusts shake the body a little near the ground.

Target table, sea-level equivalent, default jumper. The automated tests assert these within ±5 percent.

| Position | Vertical speed | Horizontal speed | Glide |
|---|---|---|---|
| Belly, neutral box | 120 mph (54 m/s) | drift only | 0 |
| Belly, hard arch | 130 to 135 mph | | |
| Belly, de-arched (slow fall) | 105 to 110 mph | | |
| Belly, maximum forward drive | about 120 mph | 10 to 15 mph | 0.1 |
| Belly, fast 360 turn | | | 1.5 to 2 s; relaxed 360 in 3 to 4 s |
| Flat track in a jumpsuit | 95 to 110 mph | 55 to 70 mph | 0.6 to 0.7 |
| Tracking suit | 70 to 85 mph | 60 to 80 mph | 1.0 to 1.3 |
| Wingsuit (intermediate suit), best glide | 45 to 55 mph | 100 to 115 mph | 2.3 to 2.6 |
| Wingsuit, minimum sink | 35 to 40 mph | 80 to 90 mph | about 2.0 |
| Wingsuit, full dive | 150 mph plus total airspeed | | stall below about 70 mph total with buffet, nose drop and loss of lift, recoverable by diving |

Starting-point polars for the builder (tune to the table, keep the shape): wingsuit S = 1.0 m², CD0 = 0.11, induced factor k = 0.35, CLmax 0.9 at 14 degrees; tracking suit S = 0.9 m², CD0 = 0.25, k = 0.6; jumpsuit track S = 0.7 m², CD0 = 0.35, k = 0.9; belly box as a plate with CdA 0.55 m² neutral, 0.45 hard arch, 0.75 de-arched, plus a small lift term from body pitch for drive.

### 7.2 Canopy model

A ram-air canopy as a lifting body on a pendulum with the jumper below, not a glide table. The builder may implement it as a three-degree-of-freedom point mass with a quasi-steady polar and a pendulum of 5 to 7 m, provided the behaviours below emerge from the forces.

- **Trim and brakes.** Symmetric brake input changes the angle of attack and the polar: full flight is fastest; around half brakes is minimum sink; deep brakes are slow and sink rises again; holding full brakes past the stall point stalls the canopy (it rocks back, surges forward on release, and loses several hundred feet). Front risers pitch the canopy nose down: faster, steeper, sink two to three times. Rear risers flatten the glide a little at a small speed cost.
- **Turns.** Differential brake commands a bank angle, limited by the canopy's toggle authority (about 45 degrees on a student canopy, 70 plus on an elliptical) with a roll rate limit. Turn rate is g tan(bank) / V, the way a canopy really turns. In the bank, the vertical component of lift drops, so the canopy dives, speed builds and sink multiplies; releasing the toggle starts a recovery arc of several seconds. Nothing in the code says "a turn costs 2.4 m/s"; the dive and the recovery arc fall out of the bank and the polar. A low toggle turn therefore puts you into the ground, as it does in life, and the debrief flags it.
- **Flare.** Pulling the brakes down raises lift and drag; vertical speed decays as lift exceeds weight; airspeed bleeds; as airspeed drops below what the brake setting can hold, lift fails and sink returns. A flare started at 10 to 12 ft on a 170 produces a level glide of two to three seconds, speed washing off to a walk, and a stand-up. Started at 25 ft, it floats and then drops you from a few feet. Started at 4 ft, you arrive at full sink. Two stages happen naturally: the first half of the stroke levels the glide, the second finishes the landing as speed decays. No timers, no flare window variable.
- **Pendulum.** The jumper's mass swings under the canopy, so a hard turn starts with the jumper swinging out and a sharp flare swings the jumper forward under the canopy. This is what first-person feels and third-person shows.
- **Line twists** spin the pair about the vertical axis at one to two turns per second with brakes still stowed and no steering authority; the player kicks out with alternating body twist; spinning line twists on an elliptical dive and need a cutaway if not cleared by decision altitude.

Target table for the included canopies, default jumper (exit weight about 214 lb). Tests assert full-flight speed and sink within ±8 percent and the turn altitude losses within ±20 percent.

| Canopy (in-game name) | Area | Wing loading | Full flight airspeed | Sink at full flight | Half brakes | 90° toggle turn, altitude lost | 180° toggle turn, altitude lost | Recovery arc |
|---|---|---|---|---|---|---|---|---|
| Student 280 | 280 ft² | 0.76 | 20 mph | 600 to 700 fpm | 14 mph, 450 fpm | 50 to 70 ft | 120 to 160 ft | 1 to 2 s |
| Sport 210 | 210 ft² | 1.0 | 25 mph | 850 fpm | 17 mph, 550 fpm | 80 to 110 ft | 200 to 250 ft | 2 s |
| Sport 170 | 170 ft² | 1.26 | 29 mph | 1,000 to 1,100 fpm | 20 mph, 650 fpm | 100 to 150 ft | 250 to 300 ft | 2 to 3 s |
| Elliptical 150 | 150 ft² | 1.43 | 33 mph | 1,300 fpm | 23 mph, 800 fpm | 180 to 220 ft | 400 to 500 ft | 4 to 5 s |
| Reserve 220 (7-cell) | 220 ft² | 0.97 | 22 mph | 800 fpm | | docile | docile | short |

Names are generic on purpose: real model names are trademarks and this is heading for the stores. Behaviour is modelled on the real equivalents. Canopy choice follows the declared licence and jump numbers in the profile plus the logbook, the way a real drop zone's chief instructor would: a student or someone with no declared licence is offered the Student 280 and the Sport 210; an A licence or 25 declared jumps adds the Sport 170; a B licence or 100 jumps adds nothing new but the hint; a C or D licence or 500 jumps adds the Elliptical 150. The rule is shown in plain words next to the choice. A friend with a thousand jumps types that in once and gets the canopy they fly. Nothing is "unlocked" by playing well. **[Claude]**

### 7.3 Opening sequence

Driven by time and airspeed, producing deceleration, altitude loss, sound and animation from one phase variable.

- Pilot chute hesitation 0.3 to 1.0 s (random), bag lift about 0.5 s, line stretch with a short snatch at 1.2 to 1.5 s, snivel 1.5 to 3 s with the slider up and the canopy partly inflated, then inflation and slider descent. Full flight by 4 to 5 s from the throw; 5 to 7 s from a wingsuit, which also deploys at a lower vertical speed and a higher horizontal one, with the arm wings unzipped first (an input).
- Peak deceleration 3 to 5 g over about one second. Altitude lost from throw to full flight 600 to 900 ft belly, 800 to 1,100 ft wingsuit.
- Deploying above about 140 mph vertical raises the chance of a hard opening steeply (8 g plus, a blurred frame, a "that hurt" flag in the debrief).

### 7.4 Altitudes and procedures

Defaults mirror current USPA and BPA practice, in feet above ground level:

- Exit 13,500 ft (per drop zone: Dubai and Sharm 13,000; Interlaken 13,000 to 14,000; Empuriabrava up to 15,000).
- Break-off 5,500 ft for a two-way with the guide; wave-off from 4,500; pull 3,500 (player's choice 2,500 to 5,500; tracking suit default 4,000; wingsuit default 4,500).
- Audible altimeter: three altitudes, default 5,500 / 4,000 / 2,000, the last a continuous siren; a flatline siren at 1,000 ft if still in freefall.
- Decision altitude for a malfunction 2,500 ft student, 1,800 ft licensed.
- AAD fires the reserve at 750 ft if vertical speed exceeds 78 mph.
- Pattern: downwind at 1,000 ft, base at 600, final at 300, into wind. Any turn over 90 degrees below 300 ft on final, or any front-riser or toggle turn over 90 degrees below 500 ft, is flagged as a low turn.

### 7.5 Malfunctions and emergency procedures

- Probabilities per jump, with a realism setting: line twists 3 percent belly, 8 percent wingsuit; spinning line twists on the Elliptical 150 an additional 2 percent; bag lock or streamer 0.5 percent; a hard opening as above. The "training" setting multiplies all of these by ten so the procedures can be practised.
- Cutaway: swipe the red pillow on the right side; the reserve static line fires the reserve automatically about one second later (on by default; can be turned off in settings for the full two-handle procedure, where the player swipes the silver handle on the left).
- The reserve is the Reserve 220 with its own opening (faster, about 3 s) and a free-bag that drifts away. A cutaway main drifts down under the wind profile and lands somewhere real; the debrief says where.

### 7.6 Landing outcomes

The outcome comes from vertical speed, ground speed (airspeed plus wind) and surface at touchdown:

| Vertical speed | Ground speed | Outcome |
|---|---|---|
| under 1.5 m/s | under 5 m/s | stand-up |
| under 1.5 m/s | 5 to 8 m/s | run it out |
| under 2.5 m/s | over 8 m/s on grass | slide |
| 2.5 to 5 m/s | any | PLF: the player rolls the phone within 0.4 s to PLF and walks away; otherwise a sprain and a flag |
| over 5 m/s, or ground speed over 15 m/s | any | injury, jump ends in the debrief with the cause |
| over 9 m/s | any | fatal; the debrief is honest and short |

Water (Dubai) and hazard polygons (runway, hangar, roads, trees) have their own outcomes and flags. Landing into wind is never required but a downwind landing shows up as ground speed and in the flags.

## 8. Controls

Both schemes exist for each phase and the player chooses on the first jump and in settings. **[Shadi: "an option for user to select which mode"]** Tilt is the default in both phases. **[Claude]**

### Freefall

- **Tilt (default):** tilt left or right drops a shoulder and turns; tilt forward is head-low (forward drive), tilt back is legs out (backslide). A thumb on the left half of the screen dragged up de-arches (slower), dragged down arches (faster). One button toggles the track (tracking is a decision, so it is a toggle, not a hold). In the wingsuit, tilt forward and back is pitch (dive and flare), left and right is bank; "unzip" is a swipe before the pull.
- **Touch:** a left thumb pad for body (forward, back, turn) and a right thumb drag for fall rate; same track button.
- **The pull:** a handle at the bottom right, where the hackey sits on the right hip; swipe it outward to throw. Touching it triggers the wave-off animation. In the wingsuit the arm wings must be unzipped first or the throw is a weak one with a higher malfunction chance.
- **Emergency handles:** red pillow lower right, silver handle lower left, appear only below decision altitude or on a malfunction, both as outward swipes.
- **Looking around:** the view follows the body; a small camera button swaps to third-person and back.

### Canopy

- **Two toggles (default):** each edge of the screen is a toggle. Drag down to pull that brake, let go to release; both down together is the flare; how far and how fast you pull is the input, and the physics decides the rest. Press inward and drag down for that side's front riser; a two-finger drag up for rear risers. Unstow the brakes at opening with a drag down on both. **[Shadi chose this as one of the two schemes]**
- **Tilt and slider:** tilt left or right to bank, one slider at the bottom for symmetric brakes; front risers on a button. **[Shadi chose this as the other]**
- **Looking:** tilting the phone back looks up at the canopy; the canopy check is literally looking up.

### Desktop

Mouse moves the body (freefall) or the toggles (canopy, left and right mouse buttons as the two toggles, wheel for symmetric brakes), keyboard for fall rate, track, pull, handles, camera.

## 9. Rendering and assets **[Claude]**

- **First-person:** forearms and gloved hands from the rigged jumper model, posed by the inputs (a turn dips an arm; de-arching brings the hands in), a wrist altimeter on the left (analogue dial by default, a digital option), a goggle vignette, head motion from turbulence and the opening shock. Under canopy: risers, toggles in the hands moving with the brake input, the canopy above with cells that deform with the brakes, lines, and the slider. Nothing else on screen except the control hints the player has not yet dismissed and the emergency handles when they apply.
- **Third-person and replay:** a full jumper with container, helmet, jumpsuit or wingsuit, animated by blending authored poses (box, arch, de-arch, track, wingsuit, reach and throw, legs up under canopy, PLF) with procedural inverse kinematics for toggles and handles; the guide uses the same model in different colours. Budget 8,000 triangles per jumper, 3,000 per canopy, 6,000 for the aircraft.
- **Assets:** a CC0 base human adapted in Blender (Shadi's Blender is reachable from this session when it is running) with modelled gear, exported as Draco-compressed glTF; a Cessna 208 Caravan with a roll-up door for version one, per-DZ aircraft (Twin Otter, Pilatus Porter) later. The asset track is owned by Claude, not MiniMax, and starts at milestone 2 in parallel with the world, because the first-person arms, the guide and the replay all need the same model; it gets a look check by Shadi on his phone before milestone 7. If the model does not pass that check, the guide ships switched off by default with a note, first-person carries version one, and the model is the first thing improved after. **[Claude]**
- **Canopy:** a ram-air mesh with top and bottom skin, nine cells (seven for the reserve), cell bulge, brake and riser deformation, three line cascades, slider, pilot chute and bridle; the opening sequence drives inflation from the phase variable.
- **Effects and post:** ACES tone mapping, no bloom on phones, subtle vignette, a speed shake, lens dirt off by default. Shadows: only the jumper's contact shadow near the ground.
- **Sound:** procedural wind (filtered noise shaped by airspeed and body position, different under canopy), engine note on the climb, the exit roar transition, audible beeps, the opening (flutter, snap, silence), canopy fabric on brake input, line hum, distant ground ambience, the guide's whoop, footsteps or a slide at landing. Spatialised for the guide's position.

## 10. The guide **[Shadi asked for a guide skydiver]**

An AI jumper who obeys the same physics. A simple controller holds a relative position (in front of you, facing you, two to three metres out), so if you de-arch beyond his range he goes low and has to come back, and if you spin he waits. He gives real signals as animations with a short caption the first few times: arch, legs out, relax, check altitude, pull. At break-off he turns 180 degrees, tracks for five to seven seconds, waves off and pulls at his own altitude; you see his opening below and later his canopy. In the tracking suit he leads the track line; in the wingsuit he leads the flight line down the valley toward the landing area and you follow, no rings. He can be switched off for solo jumps. For a non-skydiver he is the instructor; for a skydiver he is the mate on the load.

## 11. Debrief, logbook and sharing

- Per jump: number, drop zone, date and local time, aircraft, exit altitude, exit spot error (metres long or short of ideal), freefall time, deployment altitude (from the throw), max and average vertical speed, canopy time, pattern altitudes at each turn, landing outcome, distance and direction from target, ground speed and wind at touchdown, flags (low turn, late pull, downwind landing, long spot, hard opening, malfunction handled), and the full input log for replay.
- Logbook stored in IndexedDB, exportable as JSON and CSV. Totals a skydiver tracks: jumps, freefall time, by DZ, by kit. Canopy unlock by jump count is read from here.
- Share card: a PNG rendered on a canvas with the satellite thumbnail, the ground track, the headline numbers and the Boogie mark, shared through the Web Share API with a download fallback. This is the loop that brings the next friend in.
- Replay: third-person, scrubbable, with the guide, the aircraft and the cutaway main if there was one.

## 12. What comes after version one

- **Version two:** tandem (you are the instructor: drogue out at five seconds, a 365 to 400 ft² canopy, the passenger's legs up on landing), BASE from Lauterbrunnen (cliff exits, short delays, pilot chute in hand, a seven-cell, a tight landing field), freeflying if asked. **[Shadi]**
- **Version three:** multiplayer on the same load. The simulation is deterministic and input-driven from day one so two phones with the same seed and the same input logs compute the same jump; the netcode later only exchanges inputs. **[Shadi]**
- **The app:** Capacitor wrappers for Android and iOS from this codebase, licensed imagery, store listings. **[Shadi: "a complete mobile app android and ios"]**

## 13. Constraints and risks

- Satellite imagery is not 3D: buildings and trees are flat in the last 200 ft. Mitigated by the detail texture, the shadow and, per preloaded DZ, a few hand-placed boxes for the hangar and tree lines in version one, with real 3D footprints from OpenStreetMap as a version-two improvement.
- Imagery licensing for the store version (section 6). Decision needed before version two, not before version one.
- iOS Safari memory: a drop zone's tiles and models must fit comfortably under 1 GB total; the budgets in section 3 are set for that.
- Tilt controls on iOS need a permission tap and misbehave if the phone is flat on a table; the touch scheme is the fallback and the first-run prompt explains both.
- The jumper model is the biggest visual risk. The plan isolates it: first-person works without it looking perfect.

## 14. Left to the builder

Exact drop-zone coordinates and polygons (verify on the imagery), tile zoom thresholds and mesh densities within the budgets, the specific sky model, shader details, tuning constants inside the target tables, UI styling (a design pass follows the first playable), the choice of CC0 base model, sound samples, the geomorphing method, the service-worker caching strategy, and test tolerances tighter than the ones stated.

## 15. Milestones (for the plan)

1. Scaffold, tests, CI, deploy of a blank page to the chosen host, the old game moved to `legacy/`.
2. The world at Interlaken: terrain, imagery, sky, a free camera, performance on a phone. The asset track starts here.
3. Simulation core and belly freefall in first-person with the altimeter and audible, from the hill to the pull, against the target tests. Tilt and touch controls come in here so they get device time early.
4. Opening, canopy, flare, landing outcomes, debrief. **First private playable:** a link for Shadi only, a full belly jump at Interlaken on his phone.
5. Manifest with live conditions and the profile, climb, jump run and spot, drop-zone list and search, landing-area adjuster, prefetch and offline.
6. Tracking suit and wingsuit.
7. The guide (ships on by default only if the model passed its look check).
8. Third-person, replay, share card, sound polish, PWA, performance tiers. **The friends' link goes out at the end of this milestone**, unless Shadi decides to send it earlier.
9. Play-testing and tuning with the friends' feedback, and the drop-zone polygons they confirm.

There is no deadline and no spend ceiling; the pace is set by quality, and MiniMax runs are kept small, single-purpose and reviewed so spend stays sensible. **[Shadi]** Each milestone ends with a short device pass by Shadi on his own phones before the next one starts; what he finds is folded into the next milestone's briefs. Prefetch is split so the near field (what the landing needs) loads before the first jump and the rest finishes during the climb, which keeps the 20-second target without shrinking the 40 MB drop zone.
