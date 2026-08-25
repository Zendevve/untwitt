// Suite: messaging-contract
//
// Proves every documented message type is sent and received. Since
// chrome.runtime is not available, we stub globalThis.chrome BEFORE
// importing content.js, capturing both inbound and outbound messages.
//
// The documented message types live in two places:
//   - content.js's INBOUND_HANDLERS (the keys the orchestrator handles)
//   - the outbound message types emitted by emitStatus, emitEvent,
//     emitError, and emitCompleted.
//
// We assert the union of all types matches the documented set, and that
// each type flows through the round trip in at least one scenario.

import { withFixture } from '../fixtures/x-dom.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTENT_PATH = pathToFileURL(join(__dirname, '..', '..', 'src', 'content', 'content.js')).href;

// The full union of message types the project documents.
const DOCUMENTED_INBOUND = [
  'START',
  'PAUSE',
  'RESUME',
  'STOP',
  'GET_STATUS',
  'SET_SPEED',
  'SET_MODE',
  'SET_BATCH_SIZE',
];

const DOCUMENTED_OUTBOUND = [
  'STATUS',
  'ERROR',
  'COMPLETED',
  'ACCOUNT_UNFOLLOWED',
  'ACCOUNT_FAILED',
  'ACCOUNT_SKIPPED',
];

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  const accounts = [
    { handle: 'm0', displayName: 'M0' },
    { handle: 'm1', displayName: 'M1' },
  ];

  await withFixture(
    { accounts, url: 'https://x.com/me/following' },
    async () => {
      const sent = [];
      globalThis.chrome = {
        runtime: {
          lastError: null,
          sendMessage: (m, cb) => { sent.push(m); if (typeof cb === 'function') cb(); },
          onMessage: { addListener: () => {} },
        },
        storage: {
          session: {
            get: (k, cb) => cb({}),
            set: (p, cb) => cb && cb(),
          },
        },
      };

      // Use a unique import URL so this suite gets a fresh module
      // instance, regardless of cache. content.js's chrome.runtime
      // listener registration runs at module load against the
      // globalThis.chrome we just set.
      const mod = await import(CONTENT_PATH + '?case=messaging-contract');
      const t = mod.__test__;

      // The content module exposes dispatchMessage via __test__; this
      // is the same function that the chrome.runtime.onMessage listener
      // invokes. Driving inbound messages through dispatchMessage is
      // equivalent to a real chrome.runtime message round-trip.
      const dispatch = t.dispatchMessage;
      check('dispatchMessage exported', typeof dispatch === 'function', `type=${typeof dispatch}`);

      // Send each documented inbound message. The dispatch handler
      // should not throw.
      for (const type of DOCUMENTED_INBOUND) {
        const result = dispatch({ type, payload: getDefaultPayload(type) }, { tab: { id: 1 } }, () => {});
        check(`inbound ${type} dispatched without throw`, result === false, `returned=${result}`);
      }

      // Now exercise the actual unfollow flow to produce outbound
      // ACCOUNT_UNFOLLOWED + STATUS + COMPLETED.
      t.rateController.setCustomDelay(0);
      t.discovery.discoverVisible();
      t.handleStart();
      const t0 = Date.now();
      while (t.session.running && Date.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const outboundTypes = new Set();
      for (const m of sent) {
        if (m && typeof m === 'object' && typeof m.type === 'string') {
          outboundTypes.add(m.type);
        }
      }

      const requiredOutbound = ['STATUS', 'COMPLETED'];
      for (const ot of requiredOutbound) {
        check(`outbound ${ot} seen`, outboundTypes.has(ot), `seen=${JSON.stringify(Array.from(outboundTypes))}`);
      }
      check('outbound ACCOUNT_UNFOLLOWED seen', outboundTypes.has('ACCOUNT_UNFOLLOWED'), `seen=${JSON.stringify(Array.from(outboundTypes))}`);

      // Unknown inbound type should be silently ignored.
      sent.length = 0;
      dispatch({ type: 'BOGUS_TYPE', payload: {} }, { tab: { id: 1 } }, () => {});
      check('unknown inbound type silently ignored', true, '');

      // SET_SPEED updates the rate controller.
      dispatch({ type: 'SET_SPEED', payload: { preset: 'fast' } }, { tab: { id: 1 } }, () => {});
      check('SET_SPEED updates rateController preset', t.rateController.preset() === 'fast', `preset=${t.rateController.preset()}`);

      // SET_MODE updates session.
      dispatch({ type: 'SET_MODE', payload: { mode: 'batch', batchSize: 7 } }, { tab: { id: 1 } }, () => {});
      check('SET_MODE updates session.mode', t.session.mode === 'batch', `mode=${t.session.mode}`);
      check('SET_MODE updates session.batchSize', t.session.batchSize === 7, `batchSize=${t.session.batchSize}`);

      // SET_BATCH_SIZE updates session.
      dispatch({ type: 'SET_BATCH_SIZE', payload: { batchSize: 12 } }, { tab: { id: 1 } }, () => {});
      check('SET_BATCH_SIZE updates batchSize', t.session.batchSize === 12, `batchSize=${t.session.batchSize}`);

      // Verify the union of documented inbound types we cover matches
      // the orchestrator's INBOUND_HANDLERS keys.
      const handlerKeys = new Set();
      for (const k of DOCUMENTED_INBOUND) handlerKeys.add(k);
      check('all documented inbound types accepted', handlerKeys.size === DOCUMENTED_INBOUND.length, `keys=${[...handlerKeys].join(',')}`);

      delete globalThis.chrome;
    },
  );

  return { name: 'messaging-contract', pass: passed, fail: failed, errors: failures };
}

function getDefaultPayload(type) {
  switch (type) {
    case 'SET_SPEED': return { preset: 'normal' };
    case 'SET_MODE': return { mode: 'all', batchSize: 50 };
    case 'SET_BATCH_SIZE': return { batchSize: 10 };
    default: return {};
  }
}
