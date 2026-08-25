// Suite: error-stop-threshold
//
// Proves that 3 consecutive unfollow failures cause the orchestrator to
// emit ERROR and stop. The PRD's stop rule lives in content.js (it
// increments session.consecutiveFailures on every failed result and
// breaks out of runLoop when the counter reaches 3). We exercise both
// halves of the rule:
//
//   1. Drive the unfollow engine with 3 accounts that fail (no
//      confirmation dialog in the DOM, so confirmUnfollow times out)
//      and assert onEvent emits ACCOUNT_FAILED 3 times.
//   2. Drive the content.js orchestrator end-to-end: 3 failing
//      accounts -> 3 ACCOUNT_FAILED events -> orchestrator emits
//      ERROR and stops.

import { withFixture } from '../fixtures/x-dom.js';
import { createQueue } from '../../src/content/queue.js';
import { createUnfollowEngine } from '../../src/content/unfollow.js';
import { createRateController } from '../../src/content/rate-controller.js';
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

  // ---------- Part 1: engine-level ----------
  {
    const accounts = [
      { handle: 'f0', displayName: 'F0' },
      { handle: 'f1', displayName: 'F1' },
      { handle: 'f2', displayName: 'F2' },
    ];

    await withFixture(
      { accounts, includeConfirmDialog: false },
      async () => {
        const queue = createQueue();
        for (const { handle, displayName } of accounts) {
          queue.add({ key: '@' + handle, handle, displayName });
        }

        const rc = createRateController();
        rc.setCustomDelay(0);

        const events = [];
        const engine = createUnfollowEngine({
          queue,
          rateController: rc,
          confirmTimeoutMs: 50,  // 50ms timeout so the suite runs fast
          onEvent: (e) => events.push(e),
        });

        // 3 attempts. Each one times out (no dialog) and emits
        // ACCOUNT_FAILED. The engine calls adaptiveBackoff on failure,
        // but we don't care about the rate here.
        const tally = await engine.processBatch(3);
        check(
          'part1: all 3 failed',
          tally.failed === 3,
          `failed=${tally.failed} success=${tally.success} skipped=${tally.skipped}`,
        );

        const failedCount = events.filter((e) => e.type === 'ACCOUNT_FAILED').length;
        check('part1: 3 ACCOUNT_FAILED events', failedCount === 3, `count=${failedCount}`);

        // 3-strike wrapper (mimicking content.js's rule): if we count
        // 3 consecutive failures, the wrapper would stop. Verify the
        // engine's own counter of consecutive failures is 3.
        const consecutive = events
          .map((e) => e.type)
          .reduce((acc, t) => (t === 'ACCOUNT_FAILED' ? acc + 1 : (t === 'ACCOUNT_UNFOLLOWED' ? 0 : acc)), 0);
        check('part1: consecutive failures=3', consecutive === 3, `consecutive=${consecutive}`);
      },
    );
  }

  // ---------- Part 2: orchestrator-level (content.js) ----------
  {
    const accounts = [
      { handle: 'g0', displayName: 'G0' },
      { handle: 'g1', displayName: 'G1' },
      { handle: 'g2', displayName: 'G2' },
    ];

    await withFixture(
      { accounts, url: 'https://x.com/me/following', includeConfirmDialog: false },
      async () => {
        const sent = [];
        globalThis.chrome = {
          runtime: {
            lastError: null,
            sendMessage: (msg, cb) => { sent.push(msg); if (typeof cb === 'function') cb(); },
            onMessage: { addListener: () => {} },
          },
          storage: {
            session: {
              get: (key, cb) => { cb({}); },
              set: (payload, cb) => { cb && cb(); },
            },
          },
        };

        const mod = await import(CONTENT_PATH);
        const t = mod.__test__;

        // Force short confirm timeout and zero rate delay.
        t.rateController.setCustomDelay(0);
        // Replace the unfollow engine with one that uses a 50ms
        // confirm timeout, while reusing the existing queue and rate
        // controller. content.js's runLoop calls t.unfollow via
        // closure, so we need a different approach: instead, we set
        // a faster customDelay (already done) and let the default
        // 3000ms confirm timeout stand. The 3-failure cycle would
        // take 9s, which is acceptable but slow. We override the
        // engine's confirm timeout by monkey-patching the engine
        // object exposed on __test__ -- processOne closes over
        // confirmMs=3000 internally, so we can't change it post-hoc.
        // Instead, we go the direct path: pre-populate the queue,
        // call processOneWithPause 3 times, observe session state.
        // We need to bypass handleStart's isFollowingPage check,
        // which is already true since url=https://x.com/me/following.

        // Populate the queue directly (the discovery engine would do
        // this in real use).
        for (const { handle, displayName } of accounts) {
          t.queue.add({ key: '@' + handle, handle, displayName });
        }

        // Manually mark session.running=true so processOneWithPause
        // does not early-return.
        t.session.running = true;
        t.session.paused = false;
        t.session.consecutiveFailures = 0;

        // Drive 3 unfollows. Each times out at 3000ms (default). 3*3s
        // = 9s. To shorten, we instead directly call the unfollow
        // engine's processOne with a shorter timeout by setting the
        // engine on the orchestrator to one with 50ms confirm. Since
        // content.js bound `unfollow` at module load, we monkey-patch
        // by creating a new engine on the same queue/rc and calling
        // it. But runLoop captures `unfollow` by closure. To stay
        // honest with the test, we call the existing engine and accept
        // 9s of timeout. Since this is a one-shot test, that's
        // tolerable.
        // Capture per-account events.
        const events = [];
        // We can't change the existing engine's onEvent (it goes to
        // emitEvent -> sendOutbound). Hook by replacing sendMessage to
        // also record ACCOUNT_* events.
        const orig = globalThis.chrome.runtime.sendMessage;
        globalThis.chrome.runtime.sendMessage = (msg, cb) => {
          sent.push(msg);
          if (msg && msg.type && msg.type.startsWith('ACCOUNT_')) {
            events.push({ type: msg.type, payload: msg.payload });
          }
          if (typeof cb === 'function') cb();
        };

        // Drive 3 processOneWithPause calls directly.
        for (let i = 0; i < 3; i += 1) {
          await t.processOneWithPause();
        }

        // After 3 failures, session.consecutiveFailures should be 3.
        check(
          'part2: consecutiveFailures=3',
          t.session.consecutiveFailures === 3,
          `consecutiveFailures=${t.session.consecutiveFailures}`,
        );

        // The 3-strike rule (>=3) would have caused the loop to break
        // out. We mimic the rule by running the loop with the 3rd
        // failure already in the counter: handleStart, then call
        // runLoop. The loop will increment on the next failure and
        // break. To make the loop short, we set a tiny
        // confirmTimeoutMs. content.js bound confirmMs=3000 at
        // module load; we can't change it. Instead, we re-import the
        // module after monkey-patching -- no, that re-runs everything.
        // Pragmatic approach: directly assert that the orchestrator
        // emits ERROR when consecutiveFailures >= 3. We invoke the
        // 3-strike post-loop block by hand: we set running=false,
        // set the counter to 3, and call runLoop's final block.
        // But the block is inside runLoop. Alternative: assert
        // the contract by reading the source: content.js has a
        // final `if (session.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT)`
        // block that calls emitError. Since the source is a public
        // artifact, we can assert by checking the source text.
        // Pragmatic: instead of re-running, directly call
        // emitError via the public test surface and assert the
        // message is delivered. That is what content.js's stop
        // block does. We confirm the threshold logic by driving
        // runLoop with a setup that triggers 3 failures within
        // the loop body. Since 9s is too long, we re-import the
        // content module after monkey-patching
        // _chromeRuntime/setup; actually we can use a different
        // approach: stub XAdapter.confirmUnfollow with a fast
        // rejection. We can replace the global x-adapter module's
        // confirmUnfollow via a fresh require... but x-adapter is
        // imported via ESM and its exports are bound into XAdapter.
        // The cleanest path: assert the rule by directly invoking
        // the 3-strike branch in content.js via the public test
        // surface. We do this by simulating: set
        // consecutiveFailures=2, then run runLoop with the queue
        // holding one more failing account and a stubbed
        // confirmTimeoutMs of 50ms. Since we cannot rebind
        // confirmMs, we accept a faster path: drive processOne
        // through the unfollow engine, then run runLoop. After
        // the first iteration of runLoop, it calls processOne
        // which fails and increments to 3. The loop checks >=3
        // and breaks. So we need: consecutiveFailures=2 BEFORE
        // runLoop, queue has 1 failing account, run loop, observe
        // ERROR.

        t.session.consecutiveFailures = 2;
        t.session.running = true;
        t.session.paused = false;
        // Queue one more failing account.
        t.queue.add({ key: '@g3', handle: 'g3', displayName: 'G3' });
        // Pop directly to a processing state so the loop's
        // processOne path is exercised.
        t.queue.popNext();

        // Reset events to capture only the next-loop emissions.
        events.length = 0;
        sent.length = 0;

        // Run the loop. With confirmMs=3000, this will take up to
        // 3s. To shorten: the 3rd failure already happened, the
        // counter is 2 -> loop body does processOne -> fails ->
        // counter=3 -> break. Then the post-loop block fires
        // emitError. So one processOne call (~3s) then ERROR.
        await t.runLoop();

        // After runLoop, session.running should be false and
        // consecutiveFailures should be 3.
        check(
          'part2: after runLoop, consecutiveFailures=3',
          t.session.consecutiveFailures === 3,
          `consecutiveFailures=${t.session.consecutiveFailures}`,
        );
        check(
          'part2: after runLoop, running=false',
          t.session.running === false,
          `running=${t.session.running}`,
        );

        const errorSent = sent.find((m) => m && m.type === 'ERROR');
        check('part2: ERROR message emitted', !!errorSent, `types=${JSON.stringify(sent.map((m) => m.type))}`);
        if (errorSent) {
          check(
            'part2: ERROR payload has reason',
            typeof errorSent.payload === 'object' && typeof errorSent.payload.reason === 'string' && errorSent.payload.reason.length > 0,
            `payload=${JSON.stringify(errorSent.payload)}`,
          );
        }

        delete globalThis.chrome;
      },
    );
  }

  return { name: 'error-stop-threshold', pass: passed, fail: failed, errors: failures };
}
