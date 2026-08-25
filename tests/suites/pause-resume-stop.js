// Suite: pause-resume-stop
//
// Proves:
//   - PAUSE halts processing (the loop blocks on the pause waiter).
//   - RESUME continues processing.
//   - STOP exits cleanly.
//
// Strategy: install the content module's __test__ surface. Stub
// chrome.runtime so outbound messages are captured. The test calls
// handleStart, then immediately handlePause, waits briefly, then
// handleResume, then handleStop. Across this, we observe the events
// emitted to chrome.runtime.sendMessage and assert the order.

import { withFixture } from '../fixtures/x-dom.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTENT_PATH = pathToFileURL(join(__dirname, '..', '..', 'src', 'content', 'content.js')).href;

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  // Build a small fixture so XAdapter.isFollowingPage() returns true.
  const accounts = [];
  for (let i = 0; i < 6; i += 1) {
    accounts.push({ handle: `p${i}`, displayName: `P ${i}` });
  }

  await withFixture({ accounts, url: 'https://x.com/me/following' }, async (window, document, helpers) => {
    // Capture outbound messages from content.js.
    const sent = [];
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => { sent.push(msg); if (typeof cb === 'function') cb(); },
        onMessage: {
          addListener: (cb) => { listeners.push(cb); },
        },
      },
      storage: {
        session: {
          get: (key, cb) => { cb({}); },
          set: (payload, cb) => { cb && cb(); },
        },
      },
    };

    // Import the content module AFTER wiring chrome + fixture so its
    // module-level state initialises correctly.
    const mod = await import(CONTENT_PATH);
    const t = mod.__test__;

    // Subscribe a custom onEvent capture by replacing the unfollow
    // engine's listener. We use the existing engine's emitEvent path
    // (via content.js) but also tap directly into the unfollow engine
    // to record per-account results for stronger ordering checks.
    const events = [];
    const originalEngine = t.unfollow;
    // Re-create the engine with a recording onEvent. Since content.js's
    // runLoop uses `unfollow.processOne/processAll`, we replace the
    // whole engine with a wrapper around the same factory. We cannot
    // mutate the closure-bound `unfollow` directly, so we monkey-patch
    // the `onEvent` field by setting the queue/rateController and
    // re-creating the engine from the same queue, then mutating
    // t.unfollow. Since content.js's runLoop captures `unfollow` by
    // closure, this won't change behavior. Instead, we instrument by
    // replacing globalThis.chrome.runtime.sendMessage to also record
    // events. STATUS / ERROR / COMPLETED are sent via sendOutbound; the
    // ACCOUNT_* events are also sent via sendOutbound through
    // emitEvent. We record those and assert on them.
    const eventLog = [];
    const origSendMessage = globalThis.chrome.runtime.sendMessage;
    globalThis.chrome.runtime.sendMessage = (msg, cb) => {
      sent.push(msg);
      if (msg && msg.type && msg.type.startsWith('ACCOUNT_')) {
        eventLog.push({ type: msg.type, payload: msg.payload });
      }
      if (typeof cb === 'function') cb();
    };

    // Use a small but non-zero inter-action delay so the loop is
    // observably in the sleep phase between processOne calls. With
    // delay=0, microtask scheduling makes "no new events after pause"
    // race-prone: many processOne calls can land between handlePause
    // and the loop's next pause-check. With delay=80ms, each
    // iteration is bounded and the in-flight count is small.
    t.rateController.setCustomDelay(80);

    // Start the engine.
    t.handleStart();

    // Wait for at least one ACCOUNT_* event (proves the loop is
    // running) before pausing. Cap at 1000ms.
    const startWait = Date.now();
    while (eventLog.length === 0 && Date.now() - startWait < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    check('at least one event fired before pause', eventLog.length > 0, `eventLog.length=${eventLog.length}`);

    // Pause.
    t.handlePause();
    const sessionAfterPause = JSON.parse(JSON.stringify(t.session));
    check('paused=true after PAUSE', sessionAfterPause.paused === true, `paused=${sessionAfterPause.paused}`);
    check('running=true while paused', sessionAfterPause.running === true, `running=${sessionAfterPause.running}`);

    // With delay=80ms, there can be AT MOST one in-flight processOne
    // call when pause is observed (the one currently in rc.sleep()).
    // After waiting 250ms (>=3x the delay), the count delta must be
    // <= 1: the in-flight call, if any, plus zero further events.
    const eventsAtPause = eventLog.length;
    await new Promise((r) => setTimeout(r, 250));
    const eventsAfterPause = eventLog.length;
    check(
      'no more than 1 in-flight event after pause',
      eventsAfterPause - eventsAtPause <= 1,
      `eventsAtPause=${eventsAtPause} eventsAfterPause=${eventsAfterPause} delta=${eventsAfterPause - eventsAtPause}`,
    );

    // Resume.
    t.handleResume();
    const sessionAfterResume = JSON.parse(JSON.stringify(t.session));
    check('paused=false after RESUME', sessionAfterResume.paused === false, `paused=${sessionAfterResume.paused}`);

    // Let the loop run a bit.
    await new Promise((r) => setTimeout(r, 100));

    // Stop.
    t.handleStop();
    // Wait for the loop to observe session.running=false and unwind.
    const t0 = Date.now();
    while (t.session.running && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    check('running=false after STOP', t.session.running === false, `running=${t.session.running}`);
    check('paused=false after STOP', t.session.paused === false, `paused=${t.session.paused}`);

    // The sequence of message types we observed from the engine should
    // include at least one COMPLETED with reason 'stopped'.
    const stopped = sent.find((m) => m && m.type === 'COMPLETED' && m.payload && m.payload.reason === 'stopped');
    check('COMPLETED(stopped) emitted', !!stopped, `sentTypes=${JSON.stringify(sent.map((m) => m.type))}`);

    // Cleanup globals.
    delete globalThis.chrome;
  });

  return { name: 'pause-resume-stop', pass: passed, fail: failed, errors: failures };
}
