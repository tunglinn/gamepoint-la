// End-to-end tests for the IndexedDB marker autosave cache
// (marker-cache.js / marker-cache-utils.js).
//
// WHY PLAYWRIGHT AND NOT VITEST?
// The thing worth verifying here is the real flow across an actual page
// reload: mark a rally, reload (simulating a crash/refresh), re-pick the
// same video, and get offered a resume prompt backed by real IndexedDB —
// none of that exists in Node. See tests/e2e/export.spec.mjs for the same
// rationale applied to WebCodecs.
//
// SETUP: a minimal synthetic test video is generated in-browser (same
// technique as export.spec.mjs), and picked into #file-input with an
// explicit, fixed `lastModified` — Playwright's own setInputFiles() always
// stamps "now", which would give two picks of "the same" file two different
// fingerprints and make the resume flow impossible to test.

import { test, expect } from '@playwright/test';

const FIXED_LAST_MODIFIED = 1700000000000; // arbitrary but fixed across picks

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate a minimal valid H.264 MP4 entirely inside the browser.
// Returns the MP4 bytes as a plain array (JSON-serializable across the
// page.evaluate boundary).
// ─────────────────────────────────────────────────────────────────────────────
async function generateTestMp4(page) {
  return page.evaluate(async () => {
    const WIDTH = 320, HEIGHT = 240, FPS = 30, FRAMES = 30;
    const { Muxer, ArrayBufferTarget } = await import(
      'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm'
    );
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: WIDTH, height: HEIGHT },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { throw e; },
    });
    encoder.configure({
      codec: 'avc1.640028',
      width: WIDTH, height: HEIGHT,
      bitrate: 1_000_000,
      framerate: FPS,
    });
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < FRAMES; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#ff4444' : '#4444ff';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1_000_000 / FPS) });
      encoder.encode(vf, { keyFrame: i === 0 });
      vf.close();
    }
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    return Array.from(new Uint8Array(muxer.target.buffer));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: pick a file into #file-input with a caller-controlled lastModified,
// bypassing Playwright's setInputFiles (see file header comment for why).
// ─────────────────────────────────────────────────────────────────────────────
async function pickFile(page, bytesArray, { name = 'test-clip.mp4', lastModified = FIXED_LAST_MODIFIED } = {}) {
  await page.evaluate(({ bytesArray, name, lastModified }) => {
    const file = new File([new Uint8Array(bytesArray)], name, { type: 'video/mp4', lastModified });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { bytesArray, name, lastModified });
  await expect(page.locator('#snack')).toContainText('Video loaded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: add a single complete clip (serve → home point) at known timestamps.
// Same approach as export.spec.mjs's addClipViaApi — calls the real action
// functions the UI buttons call, so autosave fires exactly as it would for a
// real user.
// ─────────────────────────────────────────────────────────────────────────────
async function addClipViaApi(page, startSec, endSec) {
  await page.evaluate(({ startSec, endSec }) => {
    editorVideo.currentTime = startSec;
    pressServe();
    editorVideo.currentTime = endSec;
    pressPoint('home_point');
  }, { startSec, endSec });
}

// Waits for the debounced autosave to actually land in IndexedDB, rather
// than sleeping for a fixed guess at the debounce interval.
async function waitForAutosave(page) {
  await page.waitForFunction(async () => {
    if (!videoFile) return false;
    const data = await mcGetProject(mcFingerprint(videoFile));
    return !!data && data.clips.length > 0;
  }, undefined, { timeout: 5000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/app.html');
  await page.waitForSelector('#btn-undo', { state: 'attached' });
  await page.waitForFunction(() => typeof mcScheduleAutosave === 'function');
});

test('marking a rally autosaves, and re-picking the same video after a reload offers to resume', async ({ page }) => {
  const bytesArray = await generateTestMp4(page);
  await pickFile(page, bytesArray);

  await page.locator('#nav-editor').click();
  await addClipViaApi(page, 0.1, 0.3);
  await waitForAutosave(page);

  await page.reload();
  await page.waitForSelector('#btn-undo', { state: 'attached' });

  await pickFile(page, bytesArray); // same bytes, same fixed lastModified => same fingerprint

  await expect(page.locator('#resume-modal')).toHaveClass(/open/);
  await expect(page.locator('#resume-marker-count')).toHaveText('1');

  await page.locator('#resume-modal button:has-text("Resume")').click();
  await expect(page.locator('#resume-modal')).not.toHaveClass(/open/);

  const clipCount = await page.evaluate(() => clips.length);
  expect(clipCount).toBe(1);
});

test('picking a different video does not trigger the resume prompt', async ({ page }) => {
  const bytesArray = await generateTestMp4(page);
  await pickFile(page, bytesArray, { lastModified: FIXED_LAST_MODIFIED });

  await page.locator('#nav-editor').click();
  await addClipViaApi(page, 0.1, 0.3);
  await waitForAutosave(page);

  await page.reload();
  await page.waitForSelector('#btn-undo', { state: 'attached' });

  // Same bytes, different lastModified => different fingerprint => no cache hit.
  await pickFile(page, bytesArray, { lastModified: FIXED_LAST_MODIFIED + 1 });
  await expect(page.locator('#resume-modal')).not.toHaveClass(/open/);
});

test('Reset clears the cached session so it is not offered again', async ({ page }) => {
  const bytesArray = await generateTestMp4(page);
  await pickFile(page, bytesArray);

  await page.locator('#nav-editor').click();
  await addClipViaApi(page, 0.1, 0.3);
  await waitForAutosave(page);

  await page.locator('#editor-view').press('Escape'); // closeEditor()
  await page.locator('[title="Reset"]').click();
  await page.locator('#reset-modal button:has-text("Reset")').click();

  await page.reload();
  await page.waitForSelector('#btn-undo', { state: 'attached' });

  await pickFile(page, bytesArray);
  await expect(page.locator('#resume-modal')).not.toHaveClass(/open/);
});

test('a failed autosave (e.g. IndexedDB unavailable) tells the user to save manually instead of failing silently', async ({ page }) => {
  // Simulate an environment where IndexedDB can't be used — private browsing
  // in some browsers, or a browser that lacks it — by neutering it before any
  // page script runs. mcOpenDb()'s try/catch around indexedDB.open() means
  // this is caught the same way a real unavailable-IndexedDB error would be,
  // regardless of exactly how "unavailable" it is.
  await page.addInitScript(() => {
    try {
      Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: true });
    } catch { /* best-effort for this test */ }
  });
  await page.goto('/app.html');
  await page.waitForSelector('#btn-undo', { state: 'attached' });
  await page.waitForFunction(() => typeof mcScheduleAutosave === 'function');

  const bytesArray = await generateTestMp4(page);
  await pickFile(page, bytesArray);
  await page.locator('#nav-editor').click();
  await addClipViaApi(page, 0.1, 0.3);

  // Marking still works even though the cache can't — this must never break
  // the editor — but the user should be told, not left assuming autosave
  // silently has their back.
  await expect(page.locator('#snack')).toContainText('Autosave unavailable', { timeout: 5000 });
  const clipCount = await page.evaluate(() => clips.length);
  expect(clipCount).toBe(1);
});
