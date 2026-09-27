// Unit tests for the pure utility functions in marker-cache-utils.js.
// These run in Node.js — no DOM, no IndexedDB. The IndexedDB plumbing itself
// (marker-cache.js) is browser-only and covered by tests/e2e/marker-cache.spec.mjs
// instead — see that file's header comment for why.

import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { MC_SCHEMA_VERSION, mcFingerprint, mcBuildEnvelope, mcDebounce } =
  require('../../app/marker-cache-utils.js');

describe('mcFingerprint', () => {
  it('combines name, size, and lastModified deterministically', () => {
    const file = { name: 'match.mp4', size: 12345, lastModified: 1690000000000 };
    expect(mcFingerprint(file)).toBe('match.mp4::12345::1690000000000');
  });

  it('produces the same fingerprint for the same inputs', () => {
    const a = { name: 'match.mp4', size: 100, lastModified: 1 };
    const b = { name: 'match.mp4', size: 100, lastModified: 1 };
    expect(mcFingerprint(a)).toBe(mcFingerprint(b));
  });

  it('differs when any single field differs', () => {
    const base = { name: 'match.mp4', size: 100, lastModified: 1 };
    expect(mcFingerprint(base)).not.toBe(mcFingerprint({ ...base, size: 101 }));
    expect(mcFingerprint(base)).not.toBe(mcFingerprint({ ...base, name: 'other.mp4' }));
    expect(mcFingerprint(base)).not.toBe(mcFingerprint({ ...base, lastModified: 2 }));
  });
});

describe('mcBuildEnvelope', () => {
  it('stamps the current schema version and preserves the clip fields applyImport() needs', () => {
    const env = mcBuildEnvelope({
      videoFingerprint: 'fp-1',
      homeTeam: 'Home',
      awayTeam: 'Away',
      clips: [
        { id: 1, start: 0, end: 5, type: 'home_point', highlight: true, order: 1, extra: 'dropped' },
      ],
    });

    expect(env.schemaVersion).toBe(MC_SCHEMA_VERSION);
    expect(env.videoFingerprint).toBe('fp-1');
    expect(env.homeTeam).toBe('Home');
    expect(env.awayTeam).toBe('Away');
    expect(typeof env.savedAt).toBe('string');
    expect(env.clips).toEqual([
      { id: 1, start: 0, end: 5, type: 'home_point', highlight: true, order: 1 },
    ]);
  });

  it('coerces a missing/falsy highlight to false', () => {
    const env = mcBuildEnvelope({
      videoFingerprint: 'fp-1',
      homeTeam: 'H',
      awayTeam: 'A',
      clips: [{ id: 1, start: 0, end: 1, type: 'no_point', order: 1 }],
    });
    expect(env.clips[0].highlight).toBe(false);
  });

  it('handles an empty clip list', () => {
    const env = mcBuildEnvelope({ videoFingerprint: 'fp-1', homeTeam: 'H', awayTeam: 'A', clips: [] });
    expect(env.clips).toEqual([]);
  });
});

describe('mcDebounce', () => {
  it('does not call the wrapped function synchronously', () => {
    let calls = 0;
    const fn = mcDebounce(() => { calls++; }, 20);
    fn();
    expect(calls).toBe(0);
  });

  it('coalesces rapid calls into a single trailing call', async () => {
    let calls = 0;
    const fn = mcDebounce(() => { calls++; }, 20);
    fn(); fn(); fn();
    await new Promise(r => setTimeout(r, 40));
    expect(calls).toBe(1);
  });

  it('passes through the arguments of the last call', async () => {
    let seen;
    const fn = mcDebounce(v => { seen = v; }, 10);
    fn('a'); fn('b'); fn('c');
    await new Promise(r => setTimeout(r, 30));
    expect(seen).toBe('c');
  });
});
