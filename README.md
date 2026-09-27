# GamepointLa

A zero-install, single-page web app for marking and exporting sports footage with automatic scoreboard and highlights. Load a video file, tap **Serve** at the start of each rally and a point button at the end, then export all marked rallies stitched into one MP4 with a live scoreboard burned in.

Works on Chrome. No server, no account, no build step.

---

## Running locally

No build step required. Serve the directory over HTTP (browsers block some APIs on `file://`):

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` in Chrome.

> Any static file server works. `npx serve .` (see below) is an alternative if Node.js is available.

---

## Tests

### Setup

Install dev dependencies (Vitest + Playwright + serve — only needed for tests, not for running the app):

```bash
npm install
npx playwright install   # downloads the Chromium binary used by E2E tests
```

### Unit tests (fast, no browser)

Tests for the pure utility functions in `export-utils.js`. Runs in Node.js in ~300 ms.

```bash
npm test              # run once
npm run test:watch    # re-run on file change
```

### E2E tests (real Chromium, ~30–60 s)

Tests the full export pipeline in a real browser, including WebCodecs encode/decode, file download, and pixel-level verification that exported frames are not black.

```bash
npm run test:e2e          # headless
npm run test:e2e:ui       # Playwright interactive UI — useful for debugging
```

The E2E suite starts a local `serve` server automatically on port 5500.

### What each layer tests

| Layer | Tool | What it verifies |
|---|---|---|
| Unit | Vitest | Timestamp formatting, H.264 level selection, AVC/HEVC binary serialization, sample-window slicing |
| E2E | Playwright | Page load, video ingestion, WebCodecs export produces a valid MP4 (`ftyp` box), export progress reaches 100%, cancellation, non-black pixel output |

The E2E tests generate a synthetic red/blue alternating H.264 test video entirely inside the browser using WebCodecs, so no binary fixture file is needed.
