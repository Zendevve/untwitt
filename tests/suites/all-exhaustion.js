// Suite: all-exhaustion
//
// Proves:
//   1. processAll(idleCheck) terminates when idleCheck returns exhausted=true.
//   2. processAll(idleCheck) does not loop forever when idleCheck never
//      returns exhausted=true (it falls through the 10000-iter safety cap).

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

  // ---------- Part 1: idleCheck that returns exhausted=true ----------
  {
    const accounts = [];
    for (let i = 0; i < 3; i += 1) {
      accounts.push({ handle: `u${i}`, displayName: `User ${i}` });
    }
    await withFixture({ accounts }, async () => {
      const queue = createQueue();
      for (const { handle, displayName } of accounts) {
        queue.add({ key: '@' + handle, handle, displayName });
      }
      const rc = createRateController();
      rc.setCustomDelay(0);

      const engine = createUnfollowEngine({ queue, rateController: rc, onEvent: () => {} });

      let idleCallCount = 0;
      const idleCheck = async () => {
        idleCallCount += 1;
        return { exhausted: true };
      };

      const result = await engine.processAll(idleCheck);
      check('part1: processed=3', result.processed === 3, `processed=${result.processed}`);
      check('part1: exhausted=true', result.exhausted === true, `exhausted=${result.exhausted}`);
      check('part1: idleCheck called >=1', idleCallCount >= 1, `idleCallCount=${idleCallCount}`);
    });
  }

  // ---------- Part 2: never-exhausted idleCheck (safety cap kicks in) ----------
  {
    await withFixture(
      { accounts: [{ handle: 'a', displayName: 'A' }] },
      async () => {
        const queue = createQueue();
        queue.add({ key: '@a', handle: 'a', displayName: 'A' });
        const rc = createRateController();
        rc.setCustomDelay(0);

        const engine = createUnfollowEngine({ queue, rateController: rc, onEvent: () => {} });

        let idleCallCount = 0;
        const idleCheck = async () => {
          idleCallCount += 1;
          return { exhausted: false };
        };

        // Bounded: 10000 iterations of processOne returning null then
        // idleCheck returning {exhausted:false}. With the queue empty
        // after the first pass, every subsequent call to processOne
        // returns null immediately, so the loop is fast in practice.
        const t0 = Date.now();
        const result = await engine.processAll(idleCheck);
        const elapsed = Date.now() - t0;

        check('part2: terminated', typeof result.processed === 'number', 'no result returned');
        check(
          'part2: completed within 30s',
          elapsed < 30000,
          `elapsed=${elapsed}ms (would-be infinite if safety cap broken)`,
        );
        // Safety cap: at most 10000 idle calls.
        check(
          'part2: idleCallCount <= 10000',
          idleCallCount <= 10000,
          `idleCallCount=${idleCallCount}`,
        );
      },
    );
  }

  return { name: 'all-exhaustion', pass: passed, fail: failed, errors: failures };
}
