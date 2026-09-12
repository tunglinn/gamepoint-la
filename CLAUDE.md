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

npm run dev              # wrangler pages dev (serves the app + functions/ + D1 locally)
npm run serve            # npx serve . — static-only serving, no functions/D1
npm run db -- "<SQL>"    # wrangler d1 execute against the local persisted D1 (gamepointla-analytics)
```

Run a single unit test file: `npx vitest run tests/unit/export-utils.test.js`
Run a single e2e test by name: `npx playwright test -g "test name substring"`

No build step, no bundler, no transpiler. `npm run dev` (wrangler) is the only way to exercise `functions/` and D1 locally; `npm run serve` is enough when working purely on the client app.

## Architecture

### Two static entry points, one shared static-file root

- `index.html` + `landing/index.js` + `landing/index.css` — marketing landing page at `/`.
- `app.html` + `app/app.js` + `app/export-engine.js` — the actual editor, served at `/app` (clean URLs strip `.html`; see `serve.json` and Cloudflare Pages' default clean-URL behavior — there is no explicit routing config for this).

Both pages load `app/analytics.js` and fire a `page_view` event via `trackEvent()`, which POSTs to `/track` (a Pages Function).

### Client app split: state/UI vs. codec internals

- `app/app.js` — all editor state and UI wiring: clip list, undo/redo history, marking (serve/point) flow, marks modal, review panel, export panel UI, import/reset modals. Organized into clearly banner-commented sections (STATE, DOM, TYPE CONFIG, FILE/VIDEO, EDITOR NAV, MARKING, SCORE, HISTORY, MARKS LIST, REVIEW, EXPORT UI, PANELS, TOAST, IMPORT, RESET). Everything is global `function` declarations wired via inline `onclick=` attributes in `app.html` — no framework, no module system.
- `app/export-engine.js` — the two actual export pipelines: `doWebCodecsExport()` (primary) and `doMediaRecorderExport()` (fallback), plus MP4 parsing/demuxing helpers (`wcParseMp4`, `wcFindMoov`, `wcBuildDecoderConfig`) and canvas drawing helpers (scoreboard, watermark).
- `app/export-utils.js` — pure, dependency-free functions factored out specifically so they can be unit-tested in Node without mocking browser/codec APIs. Declared as plain `function`s (become `window` globals via `<script>` tag) with a `module.exports` guard at the bottom for Vitest's `require()`. **Any new pure logic in the export path (timestamp math, box serialization, sample-window slicing) belongs here, not in export-engine.js, if it should be unit-testable.**
- `app/lib/mp4-muxer.js` — vendored copy of the `mp4-muxer` library (not an npm dependency at runtime — loaded as a plain script).
- `app/analytics.js` — one-function `trackEvent()` helper shared by both pages.

### Why two export engines

- **WebCodecs** (`doWebCodecsExport`): frame-accurate, uses `VideoDecoder`/`VideoEncoder` + `mp4-muxer` to produce a real MP4. Chrome/Edge only (Safari lacks `VideoEncoder` support). This is the default and the one covered by e2e tests.
- **MediaRecorder** (`doMediaRecorderExport`): real-time playback capture into WebM via `MediaRecorder`. Lower accuracy, broader browser compatibility, used as fallback and for audio (WebCodecs path currently drops audio — see README "What still needs work").

### Backend: Cloudflare Pages Functions + D1 (analytics only)

- `functions/track.js` — `onRequestPost` at `/track`, inserts an event row into D1 (`events` table).
- `functions/admin.js` — `onRequestGet` at `/admin`, renders a self-contained HTML dashboard (no auth) summarizing events by type, by country, and the 50 most recent — **there is no authentication on this route**, be aware before adding sensitive data to the events table.
- `worker/schema.sql` / `worker/migrate_v2.sql` — D1 schema and migration for the `events` table. Applied manually via `npm run db`, not an automated migration runner.
- D1 binding is `DB`, database name `gamepointla-analytics` (see `wrangler.jsonc`).

### PWA / offline

`sw.js` is a hand-written service worker with a hard-coded cache name (currently `gamepointla-v3`) that must be bumped manually on any deploy that changes cached assets (`./`, `./index.html`, `/app`, `./manifest.webmanifest`, `/app/lib/mp4-muxer.js`), or users may keep serving stale files.

### Key browser-compat fixes worth knowing before touching video/export code

These are non-obvious and easy to regress:

- **Two `<video>` elements, one lazy-loaded**: `main-video` plays the full file; `editor-video` is only assigned a `src` inside `openEditor()` (and cleared on new file load). Assigning both simultaneously exhausts Android's small hardware decoder pool and freezes the main video.
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
