# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GamePointLa (product name "SportMark" in early docs) is a zero-install, single-page web app for marking rallies in volleyball match footage and exporting them as a stitched MP4 with a live scoreboard burned in. Runs entirely client-side — no upload, no account. Deployed on Cloudflare Pages, with a small Cloudflare Pages Functions + D1 backend used only for analytics.

## Commands

```bash
npm install              # dev deps only (vitest, playwright, serve) — app itself has zero runtime deps
npx playwright install   # one-time: downloads Chromium for e2e tests

npm test                 # unit tests (Vitest, Node) — fast
npm run test:watch       # unit tests, watch mode
npm run test:e2e         # e2e tests (Playwright, real Chromium) — ~30-60s
npm run test:e2e:ui      # e2e tests, interactive UI (useful for debugging failures)

npm run dev              # wrangler pages dev (serves the app + functions/ + D1 locally) — landing at localhost:8788, editor at app.localhost:8788
npm run serve            # npx serve . — static-only serving, no functions/D1
npm run db -- "<SQL>"    # wrangler d1 execute against the local persisted D1 (gamepointla-analytics)
```

Run a single unit test file: `npx vitest run tests/unit/export-utils.test.js`
Run a single e2e test by name: `npx playwright test -g "test name substring"`

No build step, no bundler, no transpiler. `npm run dev` (wrangler) is the only way to exercise `functions/` and D1 locally; `npm run serve` is enough when working purely on the client app.

## Architecture

### Two static entry points, one shared static-file root

- `index.html` + `landing/index.js` + `landing/index.css` — marketing landing page at `/`.
- `app.html` + `app/app.js` + `app/export-engine.js` — the actual editor, served at the root of the `app.` subdomain (`app.gamepointla.com`, or `app.localhost:8788` under `npm run dev`).

**Host-based routing** (`functions/_middleware.js`): both hostnames are custom domains on the same Pages project and share every static file. On an `app.*` host, `/` is rewritten to `/app` (the clean-URL form of `app.html`). On the bare domain, `/app` and `/app.html` 301 to `app.<domain>/` (keeping protocol/port; `www.` is replaced). IP hosts and `*.pages.dev` previews can't have an `app.` sibling, so they keep serving the editor at `/app` — as does `npm run serve`, which doesn't run Functions at all. `_routes.json` limits Function invocations to `/`, `/app`, `/app.html`, `/track`, `/admin`; everything else is served as a static asset without hitting the middleware. Chrome/Edge/Firefox resolve `*.localhost` to loopback automatically; Safari needs a hosts-file entry. Note IndexedDB (marker cache) and the service worker are per-origin, so data doesn't cross between the two hosts.

Both pages load `app/analytics.js` and fire a `page_view` event via `trackEvent()`, which POSTs to `/track` (a Pages Function).

### Client app split: state/UI vs. codec internals

- `app/app.js` — all editor state and UI wiring: clip list, undo/redo history, marking (serve/point) flow, marks modal, side menu, export page UI, import/reset modals. Organized into clearly banner-commented sections (STATE, DOM, TYPE CONFIG, FILE/VIDEO, LAYERS, SIDE MENU, PLAYBACK, D-PAD, ACTION BUTTONS, SCORE, UNDO/REDO, MARKS MODAL, EXPORT PANEL, PANELS, UTILS, KEYBOARD SHORTCUTS, PWA SERVICE WORKER, IMPORT, RESET, MARKER CACHE). Everything is global `function` declarations wired via inline `onclick=` attributes in `app.html` — no framework, no module system.
- **Screen structure (mobile-first):** `#editor-view` is the permanent base screen — the app opens straight into it (showing `#placeholder` "Open a Video" and the `no-video` class until a file is picked). Two layers sit on top: `#side-menu` (left drawer: team names, Open Video, Load/Save Markers, Reset) opened by `#btn-menu`, and `#export-panel` (full-screen page with a back arrow) opened by `#btn-export`. Each open layer pushes a `window.history` entry (LAYERS section: `pushLayer`/`popLayers`/`closeLayer` + a `popstate` handler) so Android's hardware/gesture Back closes the layer instead of leaving the app; in-app close buttons and Esc rewind the same entries. **Use `window.history`, never bare `history`, there — `history` is the undo/redo stack.** `openExport()` is also called by export-engine.js to re-render the page in place, so only `showExportPanel()` pushes a layer. Prioritize phones for UI work; desktop may take compromises.
- `app/export-engine.js` — the two actual export pipelines: `doWebCodecsExport()` (primary) and `doMediaRecorderExport()` (fallback), plus MP4 parsing/demuxing helpers (`wcParseMp4`, `wcFindMoov`, `wcBuildDecoderConfig`) and canvas drawing helpers (scoreboard, watermark).
- `app/export-utils.js` — pure, dependency-free functions factored out specifically so they can be unit-tested in Node without mocking browser/codec APIs. Declared as plain `function`s (become `window` globals via `<script>` tag) with a `module.exports` guard at the bottom for Vitest's `require()`. **Any new pure logic in the export path (timestamp math, box serialization, sample-window slicing) belongs here, not in export-engine.js, if it should be unit-testable.**
- `app/lib/mp4-muxer.js` — vendored copy of the `mp4-muxer` library (not an npm dependency at runtime — loaded as a plain script).
- `app/analytics.js` — one-function `trackEvent()` helper shared by both pages.
- `app/marker-cache.js` / `app/marker-cache-utils.js` — IndexedDB-backed autosave cache for in-progress marks (`clips`/team names), so a reload or crash doesn't lose marking progress. Same split as the export files: `marker-cache-utils.js` holds pure, Node-testable logic (fingerprinting the picked `File`, building the cache envelope, debouncing); `marker-cache.js` holds the actual IndexedDB open/get/put/delete calls, which are browser-only and covered by e2e tests instead. Wired into `app.js`'s MARKER CACHE section — autosave fires from `saveHistory()`/`undo()`/`redo()`, and a resume prompt (`#resume-modal`) fires from the file-input `change` listener when a cached session matches the freshly-picked file's fingerprint. This is distinct from the manual "Save Markers"/Import JSON flow (`doExport()`/`applyImport()`), which is the user-driven, cross-device file — the cache is the automatic, same-device safety net. All cache calls are defensive (never throw into the marking flow) since it's a nonessential enhancement, not a source of truth — but a failed autosave (private browsing, storage disabled/full) triggers a one-time toast telling the user to fall back to "Save Markers", rather than failing completely silently.

### Why two export engines

- **WebCodecs** (`doWebCodecsExport`): frame-accurate, uses `VideoDecoder`/`VideoEncoder` + `mp4-muxer` to produce a real MP4. Chrome/Edge only (Safari lacks `VideoEncoder` support). This is the default and the one covered by e2e tests.
- **MediaRecorder** (`doMediaRecorderExport`): real-time playback capture into WebM via `MediaRecorder`. Lower accuracy, broader browser compatibility, used as fallback and for audio (WebCodecs path currently drops audio — see README "What still needs work").

### Backend: Cloudflare Pages Functions + D1 (analytics only)

- `functions/track.js` — `onRequestPost` at `/track`, inserts an event row into D1 (`events` table).
- `functions/admin.js` — `onRequestGet` at `/admin`, renders a self-contained HTML dashboard (no auth) summarizing events by type, by country, and the 50 most recent — **there is no authentication on this route**, be aware before adding sensitive data to the events table.
- `worker/schema.sql` / `worker/migrate_v2.sql` — D1 schema and migration for the `events` table. Applied manually via `npm run db`, not an automated migration runner.
- D1 binding is `DB`, database name `gamepointla-analytics` (see `wrangler.jsonc`).

### PWA / offline

`sw.js` is a hand-written service worker with a hard-coded cache name (currently `gamepointla-v6`) that must be bumped manually on any deploy that changes cached assets (`./`, `./manifest.webmanifest`, `./app/lib/mp4-muxer.js`), or users may keep serving stale files. Only precache paths that return 200 on every host — never `/app`, which 301s cross-origin on the bare domain and would make `cache.addAll()` reject, failing the install and leaving the old worker in charge.

### Key browser-compat fixes worth knowing before touching video/export code

These are non-obvious and easy to regress:

- **Exactly one `<video>` element**: `#shared-video` lives permanently in `#editor-view`; `mainVideo` and `editorVideo` in app.js are two names for it. Don't add a second `<video>` (e.g. for a preview) — two elements race for Android's small hardware decoder pool and the loser can sit at readyState 0 forever.
- **`createImageBitmap(frame)` instead of `ctx.drawImage(frame)`**: hardware-decoded `VideoFrame`s on Android are GPU-resident textures; `drawImage` on an `OffscreenCanvas` 2D context silently produces black frames. `createImageBitmap` is required to get a CPU-accessible bitmap.
- **Blob URL, not `File.arrayBuffer()`, at export time**: `URL.createObjectURL(file)` is created at load time. Re-reading via `videoFile.arrayBuffer()` at export time can throw `NotReadableError` if Android has expired the file-pick permission (e.g. tab was backgrounded). Export reads via `fetch(videoSrc)` against the blob URL instead.
- **`firstOfClip` keyframe flag set synchronously**: the WebCodecs decoder's `output` callback is `async`. The `keyFrame` flag must be captured (`const keyFrame = firstOfClip; firstOfClip = false;`) synchronously before the first `await`, or concurrent in-flight callbacks can both encode as keyframes and corrupt the stream.
- **`wcExtractRawBox`** (in `export-utils.js`) bypasses MP4Box.js's parsed box tree and scans raw bytes for avcC/hvcC boxes, because MP4Box.js can leave `NaluArrays`/`SPS`/`PPS` empty on files with a malformed sibling box even though the underlying bytes are fine.
- **`wcParseMp4`'s box-walker only trusts `mdat` for header-only feeding.** To read a loaded video's `moov` without loading gigabytes of `mdat` into memory, `wcParseMp4` (`app/export-engine.js`) walks top-level ISO-BMFF boxes and feeds MP4Box.js only the 8/16-byte header (never the body) for boxes it classifies as skippable — `wcIsSkippableBoxType` in `export-utils.js`. That list is **`mdat` only**, confirmed empirically: MP4Box.js 0.5.2 will accept `mdat` header-only and correctly skip to the next box, but does *not* extend the same trust to `free`/`skip`/`wide` — feeding just their header leaves it stuck expecting the rest of that box's declared bytes, and desyncs the next box fed after it. Two consecutive header-only-skipped boxes in a row (e.g. a `free` padding box immediately followed by `mdat`) reproduces this. Since `free`/`skip`/`wide` are always small in practice (reserve/padding space, never gigabytes), feeding them in full is cheap and correct — don't add them back to the skippable list without re-verifying against a real MP4Box.js parse.

## Testing conventions

- Unit tests (`tests/unit/export-utils.test.js`) target only the pure functions in `export-utils.js`, run under Node with `environment: 'node'` (see `vitest.config.js`) — no DOM.
- E2E tests (`tests/e2e/export.spec.js`) run in real Chromium via Playwright because WebCodecs/OffscreenCanvas/createImageBitmap can't be meaningfully mocked. They generate a synthetic test MP4 in-browser at runtime (no binary fixtures committed) and assert on real export output (valid `ftyp` box, 100% progress, non-black pixels, cancellation).
- `playwright.config.js` auto-starts `npx serve . --listen 5500` as the test web server.
- When adding new pure export logic, add it to `export-utils.js` (not `export-engine.js`) specifically so it stays unit-testable.
