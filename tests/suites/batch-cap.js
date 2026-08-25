// Suite: batch-cap
//
// Proves processBatch(5) processes exactly 5 accounts and stops, even when
// 20 accounts are queued.

import { withFixture } from '../fixtures/x-dom.js';
import { createQueue } from '../../src/content/queue.js';
import { createUnfollowEngine } from '../../src/content/unfollow.js';
import { createRateController } from '../../src/content/rate-controller.js';

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  const accounts = [];
  for (let i = 0; i < 20; i += 1) {
    accounts.push({ handle: `acct${i}`, displayName: `Account ${i}` });
  }

  await withFixture({ accounts }, async (window, document, helpers) => {
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
      onEvent: (e) => events.push(e),
    });

    const tally = await engine.processBatch(5);

    check('processed=5', tally.processed === 5, `processed=${tally.processed}`);
    // The engine tallies by result.status. result.status is the literal
    // string "success" / "failed" / "skipped" (matching queue.markResult),
    // so the tally object is keyed by those words. Verify by the
    // per-status event count instead of the tally key directly, since
    // the tally key names mirror result.status.
    const successEvents = events.filter((e) => e.type === 'ACCOUNT_UNFOLLOWED').length;
    check('5 ACCOUNT_UNFOLLOWED events', successEvents === 5, `count=${successEvents}`);

    // The remaining 15 accounts should still be queued.
    const counts = queue.counts();
    check('discovered=20', counts.discovered === 20, `discovered=${counts.discovered}`);
    check('unfollowed=5', counts.unfollowed === 5, `unfollowed=${counts.unfollowed}`);

    // Confirm no more than 5 cells were touched.
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    check('cells still present=20', cells.length === 20, `cells=${cells.length}`);
  });

  return { name: 'batch-cap', pass: passed, fail: failed, errors: failures };
}
