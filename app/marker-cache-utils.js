// Pure utility functions for the marker autosave cache.
// No DOM references, no IndexedDB, no browser-API dependencies.
// Loaded as a plain <script> in the browser (functions become globals on window).
// Required as a CommonJS module in tests via:
//   const utils = require('./marker-cache-utils.js');

// Bump this whenever the shape of a cached envelope (in particular the `clips`
// fields applyImport() in app.js relies on) changes incompatibly. A cached
// record whose schemaVersion doesn't match the current one is treated as a
// non-match rather than migrated — see mcGetProject() in marker-cache.js.
const MC_SCHEMA_VERSION = 1;

// Identifies "the same video" across a page reload without holding onto the
// File object itself (which can't survive a reload — the user has to re-pick
// it). This is a heuristic, not a hash: two distinct files that happen to
// share name/size/lastModified would collide. Good enough for "did the user
// just re-pick the file they were marking", which is all this is for.
function mcFingerprint(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

// Builds the JSON envelope written to the cache. Deliberately the same shape
// applyImport() (app.js) already knows how to consume, so resuming a cached
// session reuses that exact restore path instead of a second one.
function mcBuildEnvelope({ videoFingerprint, homeTeam, awayTeam, clips }) {
  return {
    schemaVersion: MC_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    videoFingerprint,
    homeTeam,
    awayTeam,
    clips: clips.map(c => ({
      id:        c.id,
      start:     c.start,
      end:       c.end,
      type:      c.type,
      highlight: !!c.highlight,
      order:     c.order,
    })),
  };
}

// Coalesces rapid-fire calls (e.g. marking several rallies in quick
// succession) into a single trailing call `ms` after the last one.
function mcDebounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// CommonJS export — used by Node.js / Vitest.
// The `if` guard makes this a no-op in the browser, where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MC_SCHEMA_VERSION,
    mcFingerprint,
    mcBuildEnvelope,
    mcDebounce,
  };
}
