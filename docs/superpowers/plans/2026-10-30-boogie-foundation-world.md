# Boogie Plan 1: Foundation and the World (milestones 1 and 2)

> **For agentic workers:** This plan is executed task by task with MiniMax as the implementer and Claude as briefer, reviewer and lander (spec section 4). Each task is one MiniMax run in its own worktree; Claude reviews the diff, runs the tests and merges. Steps use checkbox (`- [ ]`) syntax for tracking. Steps marked **Orchestrator** are done by Claude, not the implementer.

**Goal:** A deployed page at Interlaken where a free camera flies from 13,500 ft down to the landing area over real terrain and real satellite imagery at a steady frame rate on a phone, with the tooling, tests and deploy pipeline every later plan builds on.

**Architecture:** A Vite + TypeScript app. `src/world/` holds pure, DOM-free geodesy, tile math, tile fetching and an elevation grid the simulation will sample later; `src/render/` holds the three.js scene: a sky with a computed sun, a quadtree of terrain tiles chosen by screen-space texel error and streamed from tile providers, a floating origin and a free camera; `src/app/` holds the loop, quality tiers and boot. Everything in `src/world/` is unit-tested in Vitest; the render side is verified on a phone.

**Tech Stack:** Node 24, Vite (latest), TypeScript 5.6+ strict, three.js r170+, Vitest, happy-dom for DOM-dependent tests, `@vitejs/plugin-basic-ssl` for HTTPS on the LAN, GitHub Actions and GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-30-boogie-design.md` (sections 3, 4, 6, 9, 13, 15 apply to this plan).

## Global Constraints

- Repository `boogie`, public, default branch `main`; the old game lives at `legacy/SkyDive-Evolution.html` and is never imported.
- Portrait phone first; `index.html` carries `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">`, the canvas fills the viewport, `touch-action: none` and `overscroll-behavior: none` on `html, body`.
- Budgets per frame: under 300 draw calls, under 1.5 million visible triangles, under 300 MB of GPU textures, under 4 MB of JavaScript (gzip) in the production build.
- Pixel ratio capped at 2.0 on the high tier.
- World units are metres. Local frame: x east, y up (metres above mean sea level), z south, so north is −z. Right-handed, three.js default.
- Earth curvature is applied to terrain vertices as a vertical drop of d² / (2 × 6,371,000) where d is horizontal distance from the local origin.
- Tile providers exactly as in spec section 6, with the attribution text "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community · Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0) · Terrain: Mapzen / AWS Terrain Tiles" visible on the page.
- Imagery zoom caps by distance from the landing area: 18 within 1,500 m, 17 within 4,000 m, 16 within 10,000 m, 14 within 30,000 m, 12 within 100,000 m, 9 beyond.
- `src/world/` imports nothing from `three` or the DOM (except `fetch`, `caches`, `createImageBitmap`, `OffscreenCanvas`, all behind injectable seams).
- Nothing in this plan is arcade: no HUD beyond the dev overlay, which is off unless `?debug=1`.
- Commits are small and conventional (`feat:`, `test:`, `chore:`, `ci:`), one task per branch, merged by the orchestrator.

## Review Focus

Failure modes the spec implies that no feature test covers by itself. Each line names the owning task where its test is added.

1. A missing or failing imagery tile (a 404 at zoom 18 over the water at Dubai, or a dropped connection on the Interlaken train) must leave the parent's texture on screen and the loop running: no black square, no thrown error. Owner: Task 9 (`computeRenderSet` falls back to the nearest ready ancestor) and Task 5 (`TileFetchError` carries the status and never rejects with a bare network error).
2. A page served over plain `http://` on the LAN, or Safari in private mode, has no `caches` API; tile fetching must work memory-only. Owner: Task 5.
3. Gryttjom sits at 60.3° N where Mercator stretches distances by two; the local frame must still measure 1,000 m as 1,000 m. Owner: Task 3.
4. Shoreline and sea tiles at Dubai and Sharm decode to zero or small negative heights, and a point with no elevation tile loaded yet must sample as 0, never NaN; the camera must never go below the ground. Owner: Tasks 4, 6 and 11.
5. A phone with a device pixel ratio of 3 and a weak GPU must settle to a lower tier within about two seconds and never bounce between tiers. Owner: Task 11.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` | tooling, strict TypeScript, base path for Pages, HTTPS dev mode for phones |
| `.github/workflows/deploy.yml` | typecheck, test, build, deploy to Pages on push to `main` |
| `legacy/SkyDive-Evolution.html` | the old game, reference only |
| `src/main.ts` | parse the URL, pick the drop zone, boot `App` |
| `src/app/App.ts` | owns renderer, scene, atmosphere, terrain, camera, loop, quality |
| `src/app/Loop.ts` | requestAnimationFrame loop, clamped dt, frame-time stats, pause on hidden |
| `src/app/Quality.ts` | quality tiers and the adaptive step-down |
| `src/data/dropzones.ts` | the `DropZone` type and the six preloaded entries |
| `src/world/geo.ts` | Web Mercator, tile coordinates, metres per pixel, `LocalFrame`, curvature |
| `src/world/terrarium.ts` | Terrarium PNG decoding |
| `src/world/providers.ts` | tile providers, URL templates, attribution |
| `src/world/TileCache.ts` | prioritised, concurrency-limited fetching with memory LRU and Cache Storage |
| `src/world/ElevationGrid.ts` | loaded height tiles and bilinear ground sampling |
| `src/world/sun.ts` | solar azimuth and elevation for a date and place |
| `src/render/Renderer.ts` | WebGL renderer setup, tone mapping, resize, pixel ratio |
| `src/render/Atmosphere.ts` | sun direction and aerial-perspective uniforms injected into materials |
| `src/render/Sky.ts` | sky dome driven by `Atmosphere` |
| `src/render/FloatingOrigin.ts` | rebases the world group around the camera |
| `src/render/FreeCamera.ts` | touch, mouse and keyboard fly camera |
| `src/render/terrain/TerrainTile.ts` | tile geometry with skirts, texture binding, height rebuilds |
| `src/render/terrain/TerrainQuadtree.ts` | pure LOD selection and render-set fallback |
| `src/render/terrain/Terrain.ts` | streaming orchestration: requests, lifecycle, budgets |
| `src/ui/DebugHud.ts` | developer overlay |
| `tests/world/*.test.ts`, `tests/app/*.test.ts`, `tests/render/terrain/*.test.ts` | Vitest suites |

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.ts`, `src/style.css`, `README.md`
- Move: `SkyDive Evolution.html` → `legacy/SkyDive-Evolution.html`
- Modify: `.gitignore` (add `.vite/`, `coverage/`)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `dev:phone` (`vite --host --mode phone`, HTTPS via basic-ssl only in that mode), `build`, `preview`, `test` (`vitest run`), `test:watch`, `typecheck` (`tsc --noEmit`). `vite.config.ts` exports `base: process.env.BASE_PATH ?? '/'`. Path alias `@/` → `src/`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from 'vitest';
describe('toolchain', () => {
  it('runs TypeScript tests', () => { const n: number = 2; expect(n + 2).toBe(4); });
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → fails because there is no `package.json`.
- [ ] **Step 3: Scaffold** — `npm create vite@latest . -- --template vanilla-ts` (or equivalent manual files), then `npm i three && npm i -D @types/three vitest happy-dom @vitejs/plugin-basic-ssl`. `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `target ES2022`, `module ESNext`, `moduleResolution bundler`, `types ["vite/client"]`, `paths {"@/*": ["./src/*"]}`. `index.html`: the viewport meta from Global Constraints, `<canvas id="view">`, `<div id="attribution">` with the attribution text, `<div id="ui">` empty. `src/style.css`: full-bleed canvas, black background, `touch-action: none`, `overscroll-behavior: none`, attribution 10 px white at 70 percent opacity bottom-left. `src/main.ts`: logs "boogie" and nothing else for now. `README.md`: three lines, how to run and test.
- [ ] **Step 4: Run tests and typecheck** — `npm test` → 1 passed; `npm run typecheck` → no errors; `npm run build` → `dist/` under 100 kB.
- [ ] **Step 5: Move the legacy game** — `mkdir legacy && git mv -f "SkyDive Evolution.html" legacy/SkyDive-Evolution.html` (the file is untracked, so `mv` then `git add`).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "chore: scaffold Vite + TypeScript + three, move legacy game"`

---

### Task 2: CI and GitHub Pages

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `vite.config.ts` (already reads `BASE_PATH`)

**Interfaces:**
- Produces: a deploy on every push to `main`; the site at `https://<account>.github.io/boogie/`.

- [ ] **Step 1: Write the workflow** — triggers `push` to `main` and `workflow_dispatch`; job `build` on `ubuntu-latest`: `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 24` and `cache: npm`, `npm ci`, `npm run typecheck`, `npm test`, `npm run build` with `env: BASE_PATH: /boogie/`, `actions/upload-pages-artifact@v3` with `path: dist`; job `deploy` with `needs: build`, `permissions: { pages: write, id-token: write }`, `environment: github-pages`, `actions/deploy-pages@v4`.
- [ ] **Step 2: Verify locally** — `BASE_PATH=/boogie/ npm run build && grep -c '/boogie/' dist/index.html` → at least 1.
- [ ] **Step 3: Commit** — `git add .github && git commit -m "ci: build, test and deploy to GitHub Pages"`
- [ ] **Step 4 (Orchestrator): create the repository and enable Pages** — `gh repo create <account>/boogie --public --source . --remote origin --push`, then `gh api -X POST repos/<account>/boogie/pages -f build_type=workflow`, watch the first run with `gh run watch`, open the URL on a phone.

---

### Task 3: Geodesy and the local frame

**Files:**
- Create: `src/world/geo.ts`
- Test: `tests/world/geo.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LonLat { lon: number; lat: number }
export interface TileCoord { z: number; x: number; y: number }
export const EARTH_RADIUS = 6378137;        // Web Mercator sphere
export const EARTH_MEAN_RADIUS = 6371000;   // curvature
export function lonLatToMercator(p: LonLat): { x: number; y: number };
export function mercatorToLonLat(x: number, y: number): LonLat;
export function lonLatToTile(p: LonLat, z: number): TileCoord;
export function tileBoundsMercator(t: TileCoord): { minX: number; minY: number; maxX: number; maxY: number };
export function tileBoundsLonLat(t: TileCoord): { west: number; south: number; east: number; north: number };
export function tileKey(t: TileCoord): string;                 // "z/x/y"
export function parentTile(t: TileCoord): TileCoord | null;    // null at z 0
export function childTiles(t: TileCoord): [TileCoord, TileCoord, TileCoord, TileCoord];
export function metersPerPixel(lat: number, z: number): number; // 256 px tiles: 156543.03392804097 * cos(lat) / 2^z
export function curvatureDrop(distance: number): number;       // distance² / (2 * EARTH_MEAN_RADIUS)
export class LocalFrame {
  constructor(public readonly origin: LonLat);
  readonly scale: number;                                       // cos(origin.lat in radians)
  toLocal(p: LonLat, heightM?: number): { x: number; y: number; z: number }; // x east, y = height, z south
  toLonLat(x: number, z: number): LonLat;
  tileBoundsLocal(t: TileCoord): { minX: number; maxX: number; minZ: number; maxZ: number }; // minZ is the north edge
}
```

- [ ] **Step 1: Write the failing tests**

```ts
it('metersPerPixel at the equator, zoom 0', () => expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1));
it('metersPerPixel at Interlaken, zoom 14', () => expect(metersPerPixel(46.68, 14)).toBeGreaterThan(6.5).toBeLessThan(6.6));
it('tile bounds contain the point used to find the tile', () => { const p = { lon: 7.88, lat: 46.68 }; const b = tileBoundsLonLat(lonLatToTile(p, 14)); expect(p.lon).toBeGreaterThanOrEqual(b.west); expect(p.lon).toBeLessThan(b.east); expect(p.lat).toBeGreaterThan(b.south); expect(p.lat).toBeLessThanOrEqual(b.north); });
it('mercator round trip', () => { const p = { lon: 55.14, lat: 25.09 }; const m = lonLatToMercator(p); const q = mercatorToLonLat(m.x, m.y); expect(q.lon).toBeCloseTo(p.lon, 9); expect(q.lat).toBeCloseTo(p.lat, 9); });
it('parent and children are consistent', () => { const t = { z: 14, x: 8550, y: 5784 }; for (const c of childTiles(t)) expect(parentTile(c)).toEqual(t); });
it('curvature drop', () => { expect(curvatureDrop(10_000)).toBeCloseTo(7.85, 1); expect(curvatureDrop(100_000)).toBeCloseTo(784.8, 0); });
it('local frame measures 1 km east as 1 km at 46.68 N', () => { const f = new LocalFrame({ lon: 7.88, lat: 46.68 }); const dLon = 1000 / (111_320 * Math.cos(46.68 * Math.PI / 180)); const l = f.toLocal({ lon: 7.88 + dLon, lat: 46.68 }); expect(l.x).toBeCloseTo(1000, -1); expect(Math.abs(l.z)).toBeLessThan(1); });
it('local frame measures 1 km north as -z at 60.3 N (Gryttjom)', () => { const f = new LocalFrame({ lon: 17.43, lat: 60.3 }); const l = f.toLocal({ lon: 17.43, lat: 60.3 + 1000 / 111_320 }); expect(l.z).toBeCloseTo(-1000, -1); expect(Math.abs(l.x)).toBeLessThan(1); });
it('toLonLat inverts toLocal', () => { const f = new LocalFrame({ lon: 7.88, lat: 46.68 }); const p = f.toLonLat(1234, -5678); const l = f.toLocal(p); expect(l.x).toBeCloseTo(1234, 3); expect(l.z).toBeCloseTo(-5678, 3); });
it('tileBoundsLocal north edge has the smaller z', () => { const f = new LocalFrame({ lon: 7.88, lat: 46.68 }); const b = f.tileBoundsLocal(lonLatToTile(f.origin, 14)); expect(b.minZ).toBeLessThan(b.maxZ); expect(b.maxX - b.minX).toBeCloseTo(b.maxZ - b.minZ, 0); });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/world/geo.test.ts` → fails, module not found.
- [ ] **Step 3: Implement `src/world/geo.ts`** — local coordinates are Mercator metres relative to the origin, multiplied by `scale`, with `z = -(mercY - originY) * scale`. Everything else is textbook Web Mercator.
- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/world/geo.test.ts` → all pass.
- [ ] **Step 5: Commit** — `git add src/world/geo.ts tests/world/geo.test.ts && git commit -m "feat(world): Web Mercator tiles, local frame, curvature"`

---

### Task 4: Terrarium decoding and tile providers

**Files:**
- Create: `src/world/terrarium.ts`, `src/world/providers.ts`
- Test: `tests/world/terrarium.test.ts`, `tests/world/providers.test.ts`

**Interfaces:**
- Consumes: `TileCoord` from Task 3.
- Produces:

```ts
// terrarium.ts
export const TERRARIUM_TILE_SIZE = 256;
export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array; // (R*256 + G + B/256) - 32768
// providers.ts
export interface TileProvider { id: string; urlTemplate: string; minZoom: number; maxZoom: number; attribution: string }
export const ELEVATION_PROVIDER: TileProvider;    // Terrarium, maxZoom 15, template .../terrarium/{z}/{x}/{y}.png
export const IMAGERY_NEAR_PROVIDER: TileProvider; // Esri World Imagery, maxZoom 19, template .../tile/{z}/{y}/{x}
export const IMAGERY_FAR_PROVIDER: TileProvider;  // EOX s2cloudless-2020_3857, maxZoom 14, template .../default/g/{z}/{y}/{x}.jpg
export const ATTRIBUTION_TEXT: string;            // exact text from Global Constraints
export function tileUrl(p: TileProvider, t: TileCoord): string;
export function imageryProviderForZoom(z: number): TileProvider; // z <= 11 far, else near
```

- [ ] **Step 1: Write the failing tests**

```ts
it('decodes sea level, one metre, half a metre and below sea level', () => {
  const px = new Uint8ClampedArray([128,0,0,255, 128,1,0,255, 128,0,128,255, 127,255,0,255]);
  const h = decodeTerrarium(px, 4, 1);
  expect(h[0]).toBe(0); expect(h[1]).toBe(1); expect(h[2]).toBe(0.5); expect(h[3]).toBe(-1);
});
it('decodes a full 256x256 tile to 65536 heights', () => { const px = new Uint8ClampedArray(256*256*4).fill(128); expect(decodeTerrarium(px, 256, 256).length).toBe(65536); });
it('formats provider URLs with the provider\'s placeholder order', () => {
  const t = { z: 14, x: 8550, y: 5784 };
  expect(tileUrl(ELEVATION_PROVIDER, t)).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/8550/5784.png');
  expect(tileUrl(IMAGERY_NEAR_PROVIDER, t)).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5784/8550');
  expect(tileUrl(IMAGERY_FAR_PROVIDER, { z: 8, x: 133, y: 90 })).toBe('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/8/90/133.jpg');
});
it('splits imagery providers at zoom 11', () => { expect(imageryProviderForZoom(11)).toBe(IMAGERY_FAR_PROVIDER); expect(imageryProviderForZoom(12)).toBe(IMAGERY_NEAR_PROVIDER); });
it('attribution names all three sources', () => { for (const s of ['Esri', 'EOX', 'Mapzen']) expect(ATTRIBUTION_TEXT).toContain(s); });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement both modules.** In `decodeTerrarium`, note the fill-128 test gives `128*256 + 128 + 0.5 - 32768 = 128.5`; the test only checks length.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(world): Terrarium decoding and tile providers"`

---

### Task 5: TileCache

**Files:**
- Create: `src/world/TileCache.ts`
- Test: `tests/world/TileCache.test.ts` (`// @vitest-environment happy-dom`)

**Interfaces:**
- Consumes: `decodeTerrarium` from Task 4.
- Produces:

```ts
export class TileFetchError extends Error { constructor(public readonly url: string, public readonly status: number) } // status 0 for network errors
export interface TileCacheOptions {
  maxEntries?: number;        // default 512, LRU over images and heights together
  concurrency?: number;       // default 8
  cacheName?: string;         // default 'boogie-tiles-v1'; Cache Storage used only if globalThis.caches exists
  fetchFn?: typeof fetch;     // default globalThis.fetch
  decodeImage?: (blob: Blob) => Promise<ImageBitmap>;                         // default createImageBitmap
  decodePixels?: (blob: Blob) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>; // default: ImageBitmap → OffscreenCanvas → getImageData
}
export class TileCache {
  constructor(opts?: TileCacheOptions);
  getImage(url: string, priority?: number): Promise<ImageBitmap>;    // lower priority number runs first; default 0
  getHeights(url: string, priority?: number): Promise<Float32Array>;
  cancel(url: string): void;        // removes a queued (not yet started) request; its promise rejects with TileFetchError(url, -1)
  has(url: string): boolean;        // in memory
  readonly size: number;
  onEvict?: (url: string, value: ImageBitmap | Float32Array) => void;
  stats(): { memoryHits: number; storageHits: number; networkFetches: number; failures: number; pending: number; inFlight: number };
}
```

- [ ] **Step 1: Write the failing tests** (a `fetchFn` stub returning `new Response(blob, { status })`, `decodeImage` stub returning `{ width: 256, height: 256 } as ImageBitmap`, `decodePixels` stub returning a filled 256×256 buffer)

```ts
it('fetches once and serves the second call from memory', async () => { /* two getImage of the same url → fetch called once, stats().memoryHits === 1 */ });
it('limits concurrency to the configured number', async () => { /* concurrency 2, 6 requests whose fetch resolves on a manual trigger; expect inFlight never exceeds 2 */ });
it('runs lower priority numbers first', async () => { /* concurrency 1; queue priorities 5, 1, 3 while the first is blocked; completion order 1, 3, 5 */ });
it('rejects with TileFetchError carrying the HTTP status', async () => { /* status 404 → rejects, err instanceof TileFetchError, err.status === 404, stats().failures === 1 */ });
it('rejects with status 0 on a network error', async () => { /* fetchFn throws TypeError → TileFetchError status 0 */ });
it('evicts least recently used beyond maxEntries and calls onEvict', async () => { /* maxEntries 2, fetch a, b, touch a, fetch c → onEvict called with b */ });
it('works when caches is undefined', async () => { /* delete (globalThis as any).caches; getImage resolves; stats().storageHits === 0 */ });
it('uses Cache Storage when present', async () => { /* stub globalThis.caches.open → { match, put }; first call put once; second TileCache instance (empty memory) → match hit, fetch not called, storageHits === 1 */ });
it('cancel removes a queued request', async () => { /* concurrency 1; a in flight, b queued; cancel(b) → b rejects with status -1, fetch called once */ });
it('decodes heights through decodePixels', async () => { /* getHeights returns Float32Array length 65536 */ });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `TileCache`** — one LRU `Map` keyed by url; a priority queue (array sorted on insert is fine at these sizes); dedupe in-flight requests by url; Cache Storage used as a read-through, write-behind layer with `cache.put(url, response.clone())` only on `response.ok`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(world): prioritised tile cache with LRU and Cache Storage"`

---

### Task 6: ElevationGrid

**Files:**
- Create: `src/world/ElevationGrid.ts`
- Test: `tests/world/ElevationGrid.test.ts`

**Interfaces:**
- Consumes: `LocalFrame`, `TileCoord`, `lonLatToTile`, `tileBoundsLonLat`, `curvatureDrop` (Task 3); `TERRARIUM_TILE_SIZE` (Task 4).
- Produces:

```ts
export class ElevationGrid {
  constructor(frame: LocalFrame, opts?: { maxZoom?: number }); // maxZoom default 14
  readonly maxZoom: number;
  addTile(t: TileCoord, heights: Float32Array): void;   // 256*256 values, row 0 = north edge
  hasTile(t: TileCoord): boolean;
  elevationTileFor(t: TileCoord): TileCoord;            // the elevation tile a render tile needs: same x,y scaled to zoom min(t.z, maxZoom)
  finestLoadedTileFor(p: LonLat): TileCoord | null;     // highest zoom ≤ maxZoom whose tile is loaded and covers p
  sample(p: LonLat): { height: number; zoom: number } | null; // bilinear on the finest loaded tile, pixel centres at (i + 0.5) / 256
  sampleLocal(x: number, z: number): number;            // height or 0 when nothing is loaded
  groundY(x: number, z: number): number;                // sampleLocal(x, z) - curvatureDrop(Math.hypot(x, z))
  tileCount(): number;
}
```

- [ ] **Step 1: Write the failing tests** (helper `rampTile(z,x,y)` making heights = row index, so height rises southward by 1 per pixel row)

```ts
it('returns null with no tiles and 0 from sampleLocal', () => { /* sample → null; sampleLocal(0,0) === 0; groundY(0,0) === 0 */ });
it('elevationTileFor caps zoom at maxZoom and rescales x,y', () => { const g = new ElevationGrid(frame); expect(g.elevationTileFor({ z: 16, x: 34202, y: 23137 })).toEqual({ z: 14, x: 8550, y: 5784 }); expect(g.elevationTileFor({ z: 10, x: 534, y: 361 })).toEqual({ z: 10, x: 534, y: 361 }); });
it('samples bilinearly inside a ramp tile', () => { /* add rampTile at zoom 14 covering the origin; sample the origin and a point 1/4 tile further south; the second is higher by about 64 (±1) */ });
it('prefers the finest loaded tile', () => { /* add a flat 100 m tile at zoom 12 and a flat 200 m tile at zoom 14 covering the origin; sample(origin).height === 200 and .zoom === 14 */ });
it('keeps negative heights', () => { /* flat -3 m tile → sample height -3 */ });
it('groundY subtracts curvature', () => { /* flat 0 tile; groundY(10000, 0) ≈ -7.85 */ });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Store tiles in a `Map<string, Float32Array>` by `tileKey`. For `sample`, iterate zoom from `maxZoom` down to 0 with `lonLatToTile` until a loaded tile is found; convert the point to fractional pixel coordinates inside that tile using Mercator bounds (uniform in Mercator space), clamp to `[0, 255]`, and bilinear-interpolate.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(world): elevation grid with bilinear ground sampling"`

---

### Task 7: Sun, sky and the first rendered frame

**Files:**
- Create: `src/world/sun.ts`, `src/render/Renderer.ts`, `src/render/Atmosphere.ts`, `src/render/Sky.ts`, `src/app/Loop.ts`, `src/app/App.ts`
- Modify: `src/main.ts`
- Test: `tests/world/sun.test.ts`, `tests/app/Loop.test.ts`

**Interfaces:**
- Consumes: `LonLat` (Task 3).
- Produces:

```ts
// sun.ts (NOAA solar position algorithm; accuracy within 0.5° is plenty)
export function sunPosition(date: Date, p: LonLat): { azimuthDeg: number; elevationDeg: number }; // azimuth from north, clockwise
export function sunDirectionLocal(date: Date, p: LonLat): { x: number; y: number; z: number };   // unit vector toward the sun: (sinA cosE, sinE, -cosA cosE)
export function localTimeToDate(p: LonLat, timeZone: string, isoDay: string, hour: number): Date;  // "2026-06-21", 10 → Date at 10:00 in that zone (use Intl)
// Renderer.ts
export class Renderer { constructor(canvas: HTMLCanvasElement); readonly gl: THREE.WebGLRenderer; setPixelRatioCap(cap: number): void; resize(): void; render(scene: THREE.Scene, camera: THREE.Camera): void; info(): { calls: number; triangles: number; textures: number } }
// Atmosphere.ts
export class Atmosphere {
  readonly uniforms: { uSunDir: { value: THREE.Vector3 }; uHorizonColor: { value: THREE.Color }; uZenithColor: { value: THREE.Color }; uBeta: { value: number }; uScaleHeight: { value: number }; uCameraY: { value: number } };
  setSun(dir: { x: number; y: number; z: number }): void;   // also derives horizon and zenith colours from sun elevation
  setVisibilityKm(km: number): void;                       // uBeta = 3 / (km * 1000); default 60 km; uScaleHeight 1500 m
  setCameraY(y: number): void;
  applyTo(material: THREE.Material): void;                 // onBeforeCompile: injects uniforms and the fog mix at the end of the fragment shader
}
// fog model (exact): t = exp(-uBeta * dist * exp(-max(0, 0.5 * (vWorldY + uCameraY)) / uScaleHeight)); color = mix(uHorizonColor, color, t)
// Sky.ts
export class Sky { constructor(atmo: Atmosphere); readonly mesh: THREE.Mesh; update(cameraPosition: THREE.Vector3): void }  // a 1,000 m radius inside-out sphere, depthWrite false, renderOrder -1, follows the camera; shader blends uZenithColor to uHorizonColor by view-direction elevation, with a sun disc and glow around uSunDir
// Loop.ts
export class Loop { constructor(cb: (dt: number, now: number) => void); start(): void; stop(): void; readonly running: boolean; stats(): { fps: number; frameMs: number }; } // dt clamped to 0.1 s; pauses on document hidden; fps and frameMs are 1 s moving averages
// App.ts
export interface AppOptions { dz: { lz: LonLat; timeZone: string; exitAltitudeFt: number }; hourLocal: number; debug: boolean; quality?: 'low' | 'medium' | 'high' } // Task 12's DropZone satisfies dz; Task 11 consumes quality
export class App { constructor(canvas: HTMLCanvasElement, opts: AppOptions); start(): void; }
```

- [ ] **Step 1: Write the failing tests**

```ts
it('sun at Interlaken at 12:00 UTC on 21 June 2026 is high in the south', () => { const s = sunPosition(new Date('2026-06-21T12:00:00Z'), { lon: 7.88, lat: 46.68 }); expect(s.elevationDeg).toBeGreaterThan(64.5); expect(s.elevationDeg).toBeLessThan(67.5); expect(s.azimuthDeg).toBeGreaterThan(165); expect(s.azimuthDeg).toBeLessThan(200); });
it('sun is below the horizon at local midnight', () => { expect(sunPosition(new Date('2026-06-21T00:00:00Z'), { lon: 7.88, lat: 46.68 }).elevationDeg).toBeLessThan(-10); });
it('sun direction is a unit vector with y = sin(elevation)', () => { /* |v| ≈ 1; v.y ≈ sin(elevationDeg) */ });
it('localTimeToDate respects the zone', () => { const d = localTimeToDate({ lon: 7.88, lat: 46.68 }, 'Europe/Zurich', '2026-06-21', 10); expect(d.toISOString()).toBe('2026-06-21T08:00:00.000Z'); });
// Loop.test.ts (happy-dom): drive requestAnimationFrame manually
it('clamps dt to 0.1 s and reports fps', () => { /* two frames 500 ms apart → cb dt === 0.1; stats().frameMs > 0 */ });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — `App` builds Renderer, Scene, Atmosphere, Sky, a `PerspectiveCamera(60, aspect, 1, 600000)` positioned 4,115 m above sea level plus the drop zone's landing-area height placeholder (0 for now) looking down at 45°, and a Loop that calls `sky.update`, `atmo.setCameraY`, `renderer.render`. `main.ts` reads `?dz=` (default `interlaken`, resolved in Task 12; until then hard-code Interlaken's `LonLat`), `?t=` hour (default 10), `?q=` tier, `?debug`. Tone mapping ACES, exposure 1.0, output sRGB.
- [ ] **Step 4: Run tests and typecheck; `npm run dev`** → a blue sky gradient with a sun disc, no errors in the console.
- [ ] **Step 5: Commit** — `git commit -m "feat(render): sun position, atmosphere uniforms, sky dome, app loop"`

---

### Task 8: Terrain tile geometry and material

**Files:**
- Create: `src/render/terrain/TerrainTile.ts`
- Test: `tests/render/terrain/TerrainTile.test.ts` (imports only the pure geometry builder; three's `BufferGeometry` works in node)

**Interfaces:**
- Consumes: `TileCoord` (Task 3), `Atmosphere` (Task 7).
- Produces:

```ts
export interface TileBounds { minX: number; maxX: number; minZ: number; maxZ: number }
export function gridSizeForZoom(z: number): number;   // z >= 16 → 65, 12..15 → 33, else 17 (vertices per side)
export interface TileGeometryOptions { bounds: TileBounds; gridSize: number; skirtDepth: number }
export function buildTileGeometry(opts: TileGeometryOptions, heightAt: (x: number, z: number) => number): THREE.BufferGeometry;
// positions are relative to the tile centre (cx, 0, cz); y = heightAt(x, z) (caller includes curvature); uv: u 0 at minX → 1 at maxX, v 0 at minZ (north) → 1 at maxZ (south); skirt ring duplicates edge vertices lowered by skirtDepth; indices for grid + skirts; no normals
export function updateTileHeights(geo: THREE.BufferGeometry, opts: TileGeometryOptions, heightAt: (x: number, z: number) => number): void; // rewrites y in place, recomputes bounding sphere
export class TerrainTile {
  constructor(coord: TileCoord, bounds: TileBounds, atmo: Atmosphere, heightAt: (x: number, z: number) => number, elevZoom: number);
  readonly coord: TileCoord; readonly bounds: TileBounds; readonly mesh: THREE.Mesh; elevZoom: number; textureZoom: number | null;
  setTexture(tex: THREE.Texture): void;       // MeshBasicMaterial map, SRGBColorSpace, flipY false, anisotropy set by caller, atmo.applyTo(material) once
  rebuildHeights(heightAt, elevZoom: number): void;
  readonly ready: boolean;                    // texture set
  dispose(): void;                            // geometry, material; NOT the texture (owned by the cache)
}
```

- [ ] **Step 1: Write the failing tests**

```ts
it('grid sizes by zoom', () => { expect(gridSizeForZoom(18)).toBe(65); expect(gridSizeForZoom(14)).toBe(33); expect(gridSizeForZoom(8)).toBe(17); });
it('builds gridSize² + 4*(gridSize) skirt vertices', () => { const g = buildTileGeometry({ bounds: b, gridSize: 5, skirtDepth: 10 }, () => 0); expect(g.getAttribute('position').count).toBe(25 + 20); });
it('puts uv (0,0) at the north-west corner and (1,1) at the south-east', () => { /* vertex 0 at (minX, minZ) has uv 0,0; vertex gridSize²-1 at (maxX, maxZ) has uv 1,1 */ });
it('applies heights and tile-relative positions', () => { /* heightAt = (x,z) => x; centre vertex has position.x ≈ 0 and y ≈ cx */ });
it('lowers skirt vertices by skirtDepth', () => { /* every skirt vertex y === corresponding edge vertex y - 10 */ });
it('updateTileHeights rewrites y without changing count', () => { /* build with 0, update with 5 → all grid y === 5 */ });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Index layout: grid triangles first, then skirt quads along each edge. Skirt depth is chosen by the caller as 2 percent of the tile width.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(render): terrain tile geometry with skirts and unlit atmosphere material"`

---

### Task 9: Quadtree LOD selection (pure)

**Files:**
- Create: `src/render/terrain/TerrainQuadtree.ts`
- Test: `tests/render/terrain/TerrainQuadtree.test.ts`

**Interfaces:**
- Consumes: `LocalFrame`, `TileCoord`, `metersPerPixel`, `childTiles`, `parentTile`, `tileKey`, `lonLatToTile` (Task 3).
- Produces:

```ts
export interface LodCamera {
  x: number; y: number; z: number;
  focalPx: number;        // drawingBufferHeightPx / (2 * tan(fovY / 2)), with the capped pixel ratio applied
  dir: { x: number; y: number; z: number }; // unit view direction
  halfAngleRad: number;   // half of the diagonal field of view: atan(sqrt(w² + h²) / (2 * focalPx))
}
export interface ZoomCap { radiusM: number; maxZoom: number }
export const DEFAULT_ZOOM_CAPS: ZoomCap[]; // [{1500,18},{4000,17},{10000,16},{30000,14},{100000,12},{Infinity,9}]
export interface LodConfig {
  tau: number;              // texels per pixel allowed before a split; default 1.0
  rootZoom: number;         // 8
  maxZoom: number;          // 18
  rootRadiusM: number;      // 250000
  zoomCaps: ZoomCap[];
  viewMarginRad: number;    // 0.35: tiles outside the view cone plus this margin are not refined
  outOfViewMaxZoom: number; // 12
  maxLeaves: number;        // 400: if select would return more, tau is multiplied by 1.25 and selection repeated, up to four times
}
export interface HeightRange { min: number; max: number }
export class TerrainQuadtree {
  constructor(frame: LocalFrame, lz: { x: number; z: number }, config?: Partial<LodConfig>);
  readonly config: LodConfig;
  rootTiles(): TileCoord[];                                      // all rootZoom tiles whose local bounds intersect the square ±rootRadiusM around lz
  zoomCapAt(x: number, z: number): number;                       // by distance from lz
  distanceToTile(cam: LodCamera, t: TileCoord, h: HeightRange): number; // distance from camera to the tile's AABB (local x/z bounds, y from h), 0 inside
  inView(cam: LodCamera, t: TileCoord, h: HeightRange): boolean;        // true if the camera is inside the AABB, or the angle between dir and the vector to the nearest AABB point ≤ halfAngleRad + viewMarginRad
  texelError(cam: LodCamera, t: TileCoord, h: HeightRange): number;     // metersPerPixel(tileCentreLat, t.z) / max(dist, 1) * focalPx
  select(cam: LodCamera, heightRange: (t: TileCoord) => HeightRange): TileCoord[]; // leaves: split while texelError > tau and z < min(maxZoom, zoomCapAt(tile centre), inView ? maxZoom : outOfViewMaxZoom); then the maxLeaves rule
}
export function computeRenderSet(desired: TileCoord[], isReady: (t: TileCoord) => boolean): TileCoord[]; // for each desired leaf walk up parents until a ready tile; dedupe by key; drop leaves with no ready ancestor
```

Why the cone and the cap: at one texel per pixel, a phone looking straight down from 13,500 ft wants zoom 16 out to about 2.5 km and zoom 15 out to about 8.7 km, which is a few hundred tiles in view and several hundred more behind the camera. The cone keeps the back coarse; the cap keeps a 4K desktop or a bad guess inside the 400-tile and 300-draw-call budgets by trading sharpness, never by dropping ground.

- [ ] **Step 1: Write the failing tests** (frame at Interlaken, lz at (0,0), flat heights `{min: 568, max: 568}`; `down = { dir: { x: 0, y: -1, z: 0 }, halfAngleRad: 0.6 }`; `focalPx 1462`, which is a 1,688 px tall render at 60° vertical field of view, an iPhone at pixel ratio 2)

```ts
it('root tiles cover ±250 km', () => { const q = new TerrainQuadtree(frame, lz); const roots = q.rootTiles(); expect(roots.length).toBeGreaterThanOrEqual(25); expect(roots.every(t => t.z === 8)).toBe(true); });
it('zoom caps follow distance from the landing area', () => { expect(q.zoomCapAt(1000, 0)).toBe(18); expect(q.zoomCapAt(3000, 0)).toBe(17); expect(q.zoomCapAt(20000, 0)).toBe(14); expect(q.zoomCapAt(200000, 0)).toBe(9); });
it('from exit altitude the tile under the camera is zoom 16', () => { const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down }; const under = q.select(cam, flat).find(t => containsLocal(frame, t, 0, 0)); expect(under?.z).toBe(16); });
it('tiles behind the camera stay at zoom 12 or coarser', () => { const cam = { x: 0, y: 568 + 4115, z: 0, focalPx: 1462, ...down }; const behind = q.select(cam, flat).filter(t => { const b = frame.tileBoundsLocal(t); return Math.min(Math.abs(b.minZ), Math.abs(b.maxZ)) > 20000; }); expect(behind.length).toBeGreaterThan(0); expect(Math.max(...behind.map(t => t.z))).toBeLessThanOrEqual(12); });
it('on final at 300 ft the tile under the camera is capped at zoom 18', () => { const cam = { x: 800, y: 568 + 91, z: 0, focalPx: 1462, ...down }; expect(q.select(cam, flat).find(t => containsLocal(frame, t, 800, 0))?.z).toBe(18); });
it('50 km away never exceeds zoom 14', () => { const cam = { x: 50000, y: 568 + 500, z: 0, focalPx: 1462, dir: { x: -1, y: -0.2, z: 0 }, halfAngleRad: 0.6 }; expect(Math.max(...q.select(cam, flat).map(t => t.z))).toBeLessThanOrEqual(14); });
it('never returns more than maxLeaves, even for a 4K desktop', () => { for (const f of [1462, 2078, 4000]) expect(q.select({ x: 0, y: 4683, z: 0, focalPx: f, ...down }, flat).length).toBeLessThanOrEqual(400); });
it('computeRenderSet falls back to the nearest ready ancestor and dedupes', () => { const leaf = { z: 16, x: 34202, y: 23137 }; const sib = { z: 16, x: 34203, y: 23137 }; const p = parentTile(leaf)!; const set = computeRenderSet([leaf, sib], t => tileKey(t) === tileKey(p)); expect(set).toEqual([p]); });
it('computeRenderSet drops a leaf with no ready ancestor', () => { expect(computeRenderSet([{ z: 16, x: 1, y: 1 }], () => false)).toEqual([]); });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `select` is a stack-based traversal from `rootTiles()`, wrapped in the maxLeaves loop. `containsLocal` is a test helper using `frame.tileBoundsLocal`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(render): quadtree LOD selection by texel error with zoom caps"`

---

### Task 10: Terrain streaming and the floating origin

**Files:**
- Create: `src/render/terrain/Terrain.ts`, `src/render/FloatingOrigin.ts`
- Modify: `src/app/App.ts`
- Test: `tests/render/FloatingOrigin.test.ts`, `tests/render/terrain/Terrain.test.ts` (happy-dom; a `TileCache` built with stub `fetchFn`/`decodeImage`/`decodePixels`, and a stub atmosphere `{ applyTo() {} } as unknown as Atmosphere`)

**Interfaces:**
- Consumes: `TileCache` (5), `ElevationGrid` (6), `Atmosphere` (7), `TerrainTile`, `gridSizeForZoom` (8), `TerrainQuadtree`, `computeRenderSet`, `LodCamera` (9), providers (4).
- Produces:

```ts
// FloatingOrigin.ts
export class FloatingOrigin {
  constructor(world: THREE.Group, thresholdM?: number);   // default 2000
  readonly offset: { x: number; z: number };              // true position = camera.position + offset
  update(camera: THREE.Camera): boolean;                  // rebase when |camera xz| > threshold: offset += round(camera xz), camera xz = 0, world.position = (-offset.x, 0, -offset.z); returns true if rebased
  truePosition(camera: THREE.Camera): { x: number; y: number; z: number };
}
// Terrain.ts
export interface TerrainOptions { tau: number; anisotropy: number; maxTextures: number; maxVisibleTiles: number; disposeDelayMs: number } // defaults from the quality tier; maxVisibleTiles 400; disposeDelayMs 2000
export class Terrain {
  constructor(world: THREE.Group, frame: LocalFrame, lz: { x: number; z: number }, elevation: ElevationGrid, cache: TileCache, atmo: Atmosphere, opts: TerrainOptions);
  update(cam: LodCamera): void;   // 1) desired = quadtree.select; 2) for each desired tile not loaded: request its elevation tile (if not in grid and not pending) then its imagery, priority = distance; 3) when imagery arrives build TerrainTile with heights from the grid (incl. curvatureDrop) and mark ready; 4) when an elevation tile arrives rebuild heights of every tile intersecting it whose elevZoom < its zoom; 5) visible = computeRenderSet(desired, ready); 6) tiles not visible for disposeDelayMs are disposed (geometry/material; textures stay in the cache) oldest first beyond maxVisibleTiles
  heightRange(t: TileCoord): HeightRange;   // from the elevation grid tile min/max, or 0 to 5,000 m while unknown
  stats(): { desired: number; visible: number; pending: number; built: number };
  setTau(tau: number): void; setAnisotropy(a: number): void;
  dispose(): void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// FloatingOrigin
it('rebases when the camera passes the threshold', () => { /* camera at (2500, 100, -300) → update returns true, offset {2500, -300}, camera.position.x === 0, world.position.x === -2500; truePosition equals the original */ });
it('does not rebase inside the threshold', () => { /* camera at (500, 100, 0) → false, offset unchanged */ });
// Terrain (fake cache: getImage resolves immediately with a stub ImageBitmap; getHeights resolves with flat heights)
it('requests elevation before imagery for a desired tile', async () => { /* record call order on the fake cache: first url contains 'terrarium' */ });
it('shows a parent until the children are ready', async () => { /* make getImage for z16 urls hang; after update(), visible tiles are z ≤ 15 and never empty once roots resolved */ });
it('rebuilds heights when a finer elevation tile arrives', async () => { /* spy on tile.rebuildHeights; deliver the z14 tile after the z12 → called with elevZoom 14 */ });
it('never exceeds maxVisibleTiles built meshes', async () => { /* maxVisibleTiles 50, fly the camera across 100 km in steps, assert stats().built ≤ 50 + desired.length */ });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `Terrain` and `FloatingOrigin`;** wire into `App`: a `world` group under the scene, `FloatingOrigin` updated first each frame, `LodCamera` built from `truePosition`, the camera's world direction, `focalPx = drawingBufferHeight / (2 * tan(fovY/2))` (from `renderer.gl.getDrawingBufferSize`) and `halfAngleRad = atan(hypot(drawingBufferWidth, drawingBufferHeight) / (2 * focalPx))`. Anisotropy from the renderer capabilities, capped by the tier. Imagery textures created with `new THREE.Texture(bitmap)`, `flipY = false`, `colorSpace = SRGBColorSpace`, `generateMipmaps = true`, `minFilter = LinearMipmapLinearFilter`, stored in a `Map<url, Texture>` that disposes the GPU texture when the cache evicts the bitmap (`cache.onEvict`).
- [ ] **Step 4: Run tests; `npm run dev`** → Interlaken appears from 13,500 ft: lakes, the valley, the Eiger wall; tiles refine as the camera descends; no holes, no exceptions. Check `renderer.info()` in the console: calls under 300, triangles under 1.5 M.
- [ ] **Step 5: Commit** — `git commit -m "feat(render): streamed terrain tiles with fallback and a floating origin"`

---

### Task 11: Free camera, debug overlay, quality tiers

**Files:**
- Create: `src/render/FreeCamera.ts`, `src/ui/DebugHud.ts`, `src/app/Quality.ts`
- Modify: `src/app/App.ts`, `src/main.ts`, `index.html` (three buttons inside `#ui`: "13,500 ft", "1,000 ft", "ground")
- Test: `tests/app/Quality.test.ts`, `tests/render/FreeCamera.test.ts` (happy-dom, pointer events dispatched on a div)

**Interfaces:**
- Consumes: `ElevationGrid.groundY` (6), `Loop.stats` (7), `Renderer.setPixelRatioCap` (7), `Terrain.setTau/setAnisotropy` (10).
- Produces:

```ts
// Quality.ts
export type QualityTier = 'low' | 'medium' | 'high';
export const QUALITY: Record<QualityTier, { maxPixelRatio: number; tau: number; anisotropy: number; maxTextures: number }>; // low {1.0, 2.0, 2, 256}, medium {1.5, 1.4, 4, 384}, high {2.0, 1.0, 8, 512}
export function defaultTier(dpr: number, hardwareConcurrency: number): QualityTier; // dpr >= 3 or cores <= 4 → medium, else high
export class AdaptiveQuality {
  constructor(initial: QualityTier, opts?: { thresholdMs?: number; sustainMs?: number; cooldownMs?: number }); // 20, 2000, 5000
  readonly tier: QualityTier; locked: boolean;
  pushFrame(frameMs: number, nowMs: number): QualityTier | null; // EMA α 0.1; when EMA > threshold continuously for sustainMs and not within cooldown of the last change: step down one tier and return it; never steps up
}
// FreeCamera.ts
export class FreeCamera {
  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, groundY: (x: number, z: number) => number);
  yaw: number; pitch: number;        // radians; pitch clamped to ±1.5
  setPose(x: number, y: number, z: number, yaw: number, pitch: number): void;
  update(dt: number): void;          // keyboard WASD/QE/Shift ×4; one pointer drag = look (0.004 rad per px); two pointers: centroid drag = move forward/right in the heading at speed, pinch = altitude; speed = clamp(agl * 0.5, 5, 400) m/s; after moving, y = max(y, groundY + 2)
  readonly agl: number;              // y - groundY(x, z) from the last update
}
// DebugHud.ts
export class DebugHud { constructor(container: HTMLElement); set(data: Record<string, string | number>): void; show(on: boolean): void } // one line per key, monospace, 11 px, top-left, pointer-events none
```

- [ ] **Step 1: Write the failing tests**

```ts
it('defaultTier picks medium for dpr 3', () => { expect(defaultTier(3, 8)).toBe('medium'); expect(defaultTier(2, 8)).toBe('high'); });
it('steps down after 2 s of slow frames and then holds through the cooldown', () => { const q = new AdaptiveQuality('high'); let changed: string[] = []; for (let t = 0; t <= 2100; t += 16) { const r = q.pushFrame(30, t); if (r) changed.push(r); } expect(changed).toEqual(['medium']); for (let t = 2116; t <= 6000; t += 16) { const r = q.pushFrame(30, t); if (r) changed.push(r); } expect(changed).toEqual(['medium']); });
it('never steps below low and never steps up', () => { /* start low, slow frames → null forever; start medium, fast frames → null */ });
it('free camera never goes below ground', () => { /* groundY = () => 100; setPose(0, 50, 0, 0, 0); update(0.016) → camera.position.y >= 102 */ });
it('one-pointer drag changes yaw and pitch', () => { /* pointerdown at (100,100), pointermove to (200,150), pointerup → yaw changed by ≈ -0.4, pitch by ≈ -0.2 (sign convention: drag right turns right, drag down looks down) */ });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement;** wire into `App`: the HUD shows fps, frame ms, tier, dpr, desired/visible/pending tiles, draw calls, triangles, MSL, AGL, lon/lat. The three buttons call `setPose` above the landing area at 4,115 m, 305 m and 2 m AGL looking down at 60°, 30° and level respectively. `?q=` locks the tier. On a tier change: `renderer.setPixelRatioCap`, `terrain.setTau`, `terrain.setAnisotropy`.
- [ ] **Step 4: Run tests; `npm run dev:phone`** and open the LAN URL on both phones (accept the self-signed certificate); fly from exit altitude to the ground. Expected: 60 fps on the high tier on the iPhone, a step down at most once on the Android, no holes, the ground sharp on final.
- [ ] **Step 5: Commit** — `git commit -m "feat(app): free camera, debug overlay, adaptive quality tiers"`

---

### Task 12: Drop-zone data

**Files:**
- Create: `src/data/dropzones.ts`
- Modify: `src/main.ts` (resolve `?dz=`), `src/app/App.ts` (origin from the drop zone, start pose above its landing area at the elevation sampled once the first elevation tile arrives)
- Test: `tests/data/dropzones.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DropZone {
  id: 'sharm' | 'dubai' | 'empuriabrava' | 'gryttjom' | 'hinton' | 'interlaken' | string;
  name: string; country: string; countryCode: string;
  lz: LonLat; lzRadiusM: number;           // landing-area centre and radius (default 100 m; refined later by the adjuster)
  exitAltitudeFt: number;                  // 13000 Sharm/Dubai, 13500 Empuriabrava/Gryttjom/Hinton, 13500 Interlaken
  units: 'ft' | 'm';                       // m at Gryttjom, Interlaken, Empuriabrava; ft elsewhere
  timeZone: string;                        // IANA
  aircraft: 'C208';
  jumpRunHeadingDeg?: number;
  notes?: string;
}
export const DROP_ZONES: readonly DropZone[];  // the six from the spec, coordinates as in spec section 6
export function findDropZone(id: string): DropZone | undefined;
export const DEFAULT_DROP_ZONE_ID = 'interlaken';
```

- [ ] **Step 1: Write the failing tests**

```ts
it('has the six preloaded drop zones with valid fields', () => { expect(DROP_ZONES.map(d => d.id).sort()).toEqual(['dubai','empuriabrava','gryttjom','hinton','interlaken','sharm']); for (const d of DROP_ZONES) { expect(Math.abs(d.lz.lat)).toBeLessThanOrEqual(90); expect(Math.abs(d.lz.lon)).toBeLessThanOrEqual(180); expect(d.exitAltitudeFt).toBeGreaterThanOrEqual(12000); expect(() => new Intl.DateTimeFormat('en', { timeZone: d.timeZone })).not.toThrow(); } });
it('uses metres at the three European metric DZs', () => { for (const id of ['gryttjom','interlaken','empuriabrava']) expect(findDropZone(id)?.units).toBe('m'); expect(findDropZone('hinton')?.units).toBe('ft'); });
it('findDropZone returns undefined for unknown ids', () => { expect(findDropZone('nowhere')).toBeUndefined(); });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement;** `main.ts` falls back to the default for an unknown `?dz=`. The start pose waits for the first elevation sample at the landing area (poll `elevation.sample(dz.lz)` each frame until non-null, then place the camera once).
- [ ] **Step 4: Run tests; open `?dz=dubai` and `?dz=gryttjom`** → the Palm with water all round; the forest strip at 60° N without distortion.
- [ ] **Step 5: Commit** — `git commit -m "feat(data): the six preloaded drop zones"`
- [ ] **Step 6 (Orchestrator): milestone 2 device pass** — both phones, all six drop zones, note frame rate, tile pops and any wrong landing-area placement; file the findings into Plan 2's briefs; push to `main` and confirm the Pages deploy serves it.

---

## Self-review notes

- Spec coverage for milestones 1 and 2: scaffold (1), CI and Pages (2), real elevation and imagery with the exact providers and attribution (4, 5, 6, 10), zoom caps (9), curvature (3, 10), floating origin (10), sky with computed sun and aerial perspective (7), terrain mesh with skirts and no-pop fallback (8, 9, 10), free camera and phone performance with quality tiers (11), the six drop zones with units (12). Deferred to later plans by the spec itself: geomorphing (fallback-to-ancestor covers pops for now), the below-500-ft detail texture, prefetch and offline (milestone 5), clouds and cloud shadows (milestone 8 polish).
- Names used across tasks match: `LocalFrame`, `TileCoord`, `tileKey`, `parentTile`, `childTiles`, `metersPerPixel`, `curvatureDrop`, `TileCache.getImage/getHeights/onEvict`, `ElevationGrid.sample/sampleLocal/groundY/elevationTileFor`, `Atmosphere.applyTo/setSun/setCameraY`, `AppOptions`, `TerrainTile.setTexture/rebuildHeights/ready/elevZoom`, `TerrainQuadtree.select/inView`, `computeRenderSet`, `LodCamera.focalPx/dir/halfAngleRad`, `Terrain.update/setTau/setAnisotropy/stats`, `FloatingOrigin.update/truePosition`, `AdaptiveQuality.pushFrame`, `FreeCamera.setPose/update/agl`, `DropZone`.
- Budget check done by hand: with the view cone, a phone at pixel ratio 2 looking down from exit altitude selects roughly 110 zoom-16 tiles and 110 zoom-15 tiles in view plus a coarse ring behind, under 300 draw calls after frustum culling and about 100 MB of tile textures; the `maxLeaves` rule is the backstop for larger screens.
- Review Focus lines each have a test in the owning task (Task 5 caches-undefined and 404; Task 9 fallback; Task 3 Gryttjom; Tasks 4 and 6 negative and missing heights; Task 11 ground clamp and tier step-down).
