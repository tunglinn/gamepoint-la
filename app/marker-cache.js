// IndexedDB-backed autosave cache for in-progress marking sessions.
//
// WHY THIS EXISTS
// clips/history in app.js live only in memory (see the STATE section there).
// A reload, crash, or accidental tab close loses every mark. This file adds
// a browser-storage layer app.js can autosave into and restore from — see
// mcScheduleAutosave()/mcCheckForResume() in app.js's MARKER CACHE section
// for the actual wiring; this file is just the IndexedDB plumbing.
//
// Every call here is defensive: opening/reading/writing the cache must never
// block or break marking, so failures (quota exceeded, private-mode storage
// disabled, IndexedDB missing entirely) resolve to null/undefined/false
// instead of throwing or rejecting — mcSaveProject()'s boolean result is used
// by app.js to surface a one-time warning rather than fail completely silently.
//
// Bump MC_DB_VERSION (mirroring the sw.js CACHE-name-bump convention) only if
// the object store's structure itself needs to change; onupgradeneeded below
// is where that migration/recreation logic would go. This is separate from
// MC_SCHEMA_VERSION (marker-cache-utils.js), which versions the shape of the
// JSON stored *in* a record, not the store itself.
const MC_DB_NAME    = 'gamepointla-marks';
const MC_DB_VERSION = 1;
const MC_STORE      = 'projects';

let mcDbPromise = null;

function mcOpenDb() {
  if (mcDbPromise) return mcDbPromise;
  mcDbPromise = new Promise(resolve => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open(MC_DB_NAME, MC_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MC_STORE)) {
        db.createObjectStore(MC_STORE, { keyPath: 'videoFingerprint' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(null);
  });
  return mcDbPromise;
}

// Resolves to whether the write actually landed. The caller doesn't have to
// await this (autosave firing slightly late is fine), but it's used to warn
// the user once if the cache isn't available — see mcScheduleAutosave() in
// app.js — since "we tried to save and silently couldn't" is worth telling
// them rather than swallowing entirely.
async function mcSaveProject(envelope) {
  const db = await mcOpenDb();
  if (!db) return false;
  return new Promise(resolve => {
    try {
      const tx  = db.transaction(MC_STORE, 'readwrite');
      const req = tx.objectStore(MC_STORE).put(envelope);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => resolve(false);
      tx.onerror    = () => resolve(false); // e.g. quota exceeded
    } catch {
      resolve(false);
    }
  });
}

// Resolves to the cached envelope for this fingerprint, or undefined if
// there isn't one, storage is unavailable, or the cached record's schema is
// stale (see MC_SCHEMA_VERSION in marker-cache-utils.js).
async function mcGetProject(fingerprint) {
  const db = await mcOpenDb();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const req = db.transaction(MC_STORE, 'readonly').objectStore(MC_STORE).get(fingerprint);
      req.onsuccess = () => {
        const data = req.result;
        resolve(data && data.schemaVersion === MC_SCHEMA_VERSION ? data : undefined);
      };
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function mcDeleteProject(fingerprint) {
  const db = await mcOpenDb();
  if (!db) return;
  try {
    db.transaction(MC_STORE, 'readwrite').objectStore(MC_STORE).delete(fingerprint);
  } catch { /* best-effort */ }
}
