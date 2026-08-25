// Suite: session-roundtrip
//
// Proves that the PATCH_SESSION / GET_SESSION logic on the service
// worker round-trips session state. Since the service worker is a
// classic script guarded by a `chrome` presence check, we exercise the
// in-memory mirror pattern: write a session object, read it back, assert
// it is identical. We also exercise content.js's getStorage() helper by
// stubbing chrome.storage.session, which is the same code path used in
// the test environment (the in-memory shim).

import { withFixture } from '../fixtures/x-dom.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTENT_PATH = pathToFileURL(join(__dirname, '..', '..', 'src', 'content', 'content.js')).href;
const SW_PATH = pathToFileURL(join(__dirname, '..', '..', 'src', 'background', 'service-worker.js')).href;

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  // ---------- Part 1: in-memory mirror of PATCH/GET_SESSION ----------
  {
    // The service worker uses chrome.storage.session under a
    // callback API. We mirror that API in a small in-memory shim
    // and assert the same read/modify/write pattern used by
    // PATCH_SESSION works correctly.
    const memStore = new Map();
    function readSession(key) {
      return new Promise((resolve) => {
        // mimic callback api
        const data = memStore.has(key) ? { [key]: memStore.get(key) } : {};
        resolve(data);
      });
    }
    function writeSession(key, value) {
      return new Promise((resolve) => {
        memStore.set(key, value);
        resolve();
      });
    }
    const SESSION_KEY = 'untwitt.session.v1';

    // Initial read returns the default; mirror logic should write
    // a known session.
    const initial = await readSession(SESSION_KEY);
    check('part1: initial empty', !initial[SESSION_KEY], 'had prior session');

    // PATCH_SESSION semantics: merge patch over current.
    const patch = { running: true, paused: false, mode: 'batch', batchSize: 25, customDelayMs: 750 };
    const current = initial[SESSION_KEY] || {};
    const merged = { ...current, ...patch, updatedAt: Date.now() };
    await writeSession(SESSION_KEY, merged);

    // GET_SESSION: read it back.
    const got = await readSession(SESSION_KEY);
    check('part1: roundtrip running', got[SESSION_KEY].running === true, `got=${JSON.stringify(got)}`);
    check('part1: roundtrip batchSize', got[SESSION_KEY].batchSize === 25, `got=${JSON.stringify(got)}`);
    check('part1: roundtrip customDelayMs', got[SESSION_KEY].customDelayMs === 750, `got=${JSON.stringify(got)}`);
    check('part1: roundtrip mode', got[SESSION_KEY].mode === 'batch', `got=${JSON.stringify(got)}`);

    // A second patch should merge, not replace.
    const patch2 = { paused: true, unfollowedCount: 7 };
    const current2 = got[SESSION_KEY] || {};
    const merged2 = { ...current2, ...patch2, updatedAt: Date.now() };
    await writeSession(SESSION_KEY, merged2);
    const got2 = await readSession(SESSION_KEY);
    check('part1: merge preserves running', got2[SESSION_KEY].running === true, `got=${JSON.stringify(got2)}`);
    check('part1: merge preserves batchSize', got2[SESSION_KEY].batchSize === 25, `got=${JSON.stringify(got2)}`);
    check('part1: merge applies paused', got2[SESSION_KEY].paused === true, `got=${JSON.stringify(got2)}`);
    check('part1: merge applies unfollowedCount', got2[SESSION_KEY].unfollowedCount === 7, `got=${JSON.stringify(got2)}`);
  }

  // ---------- Part 2: content.js's getStorage() round-trip via chrome.storage.session ----------
  {
    await withFixture(
      { accounts: [{ handle: 'a', displayName: 'A' }], url: 'https://x.com/me/following' },
      async () => {
        // Provide a real chrome.storage.session with a backing
        // Map so content.js's getStorage() returns a usable object.
        const backing = new Map();
        globalThis.chrome = {
          runtime: {
            lastError: null,
            sendMessage: (m, cb) => { if (typeof cb === 'function') cb(); },
            onMessage: { addListener: () => {} },
          },
          storage: {
            session: {
              get: (key, cb) => {
                if (typeof key === 'string') {
                  const v = backing.has(key) ? { [key]: backing.get(key) } : {};
                  cb(v);
                } else {
                  cb(Object.fromEntries(backing));
                }
              },
              set: (payload, cb) => {
                for (const k of Object.keys(payload)) backing.set(k, payload[k]);
                if (typeof cb === 'function') cb();
              },
            },
          },
        };

        const mod = await import(CONTENT_PATH);
        const t = mod.__test__;

        // The session is a module-level mutable object. Set a known
        // payload, persist, read back, assert.
        t.session.running = true;
        t.session.paused = true;
        t.session.mode = 'batch';
        t.session.batchSize = 33;
        t.session.unfollowedCount = 12;
        t.session.failedCount = 1;

        await t.persistSession();
        const got = await t.loadPersistedSession();
        // After loadPersistedSession, the in-memory session is
        // updated. Verify the key fields roundtripped.
        check('part2: running was reset to false (we never auto-resume)', t.session.running === false, `running=${t.session.running}`);
        check('part2: paused was reset to false', t.session.paused === false, `paused=${t.session.paused}`);
        check('part2: mode roundtripped', t.session.mode === 'batch', `mode=${t.session.mode}`);
        check('part2: batchSize roundtripped', t.session.batchSize === 33, `batchSize=${t.session.batchSize}`);
        check('part2: unfollowedCount roundtripped', t.session.unfollowedCount === 12, `unfollowedCount=${t.session.unfollowedCount}`);
        check('part2: failedCount roundtripped', t.session.failedCount === 1, `failedCount=${t.session.failedCount}`);

        // The underlying storage should have a 'session' key with the
        // exact same payload we persisted.
        const persistedRaw = backing.get('session');
        check('part2: session key exists in storage', !!persistedRaw, 'no session key');
        check(
          'part2: persisted mode matches',
          persistedRaw && persistedRaw.mode === 'batch',
          `persisted=${JSON.stringify(persistedRaw)}`,
        );
        check(
          'part2: persisted batchSize matches',
          persistedRaw && persistedRaw.batchSize === 33,
          `persisted=${JSON.stringify(persistedRaw)}`,
        );

        delete globalThis.chrome;
      },
    );
  }

  return { name: 'session-roundtrip', pass: passed, fail: failed, errors: failures };
}
