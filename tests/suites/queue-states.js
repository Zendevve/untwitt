// Suite: queue-states
//
// Proves every account transitions through queued -> processing ->
// {success | failed | skipped} and the queue's counter increments are
// correct.

import { createQueue } from '../../src/content/queue.js';

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  // ---------- Pure-queue state transitions ----------
  {
    const q = createQueue();
    q.add({ key: '@alice', handle: 'alice', displayName: 'Alice' });
    q.add({ key: '@bob', handle: 'bob', displayName: 'Bob' });
    q.add({ key: '@carol', handle: 'carol', displayName: 'Carol' });

    // After adds: every account is in 'queued' state.
    const all = q.all();
    check('3 accounts queued', all.length === 3, `len=${all.length}`);
    check('all initially queued', all.every((a) => a.state === 'queued'), 'not all queued');

    // popNext transitions the first account to 'processing'.
    const next = q.popNext();
    check('popNext returns account', !!next, 'no account returned');
    check('popNext account state=processing', next.state === 'processing', `state=${next.state}`);

    // Counts: discovered=3, queued=2, processing=1.
    const c1 = q.counts();
    check('counts discovered=3', c1.discovered === 3, `discovered=${c1.discovered}`);
    check('counts queued=2', c1.queued === 2, `queued=${c1.queued}`);
    check('counts processing=1', q.processingCount() === 1, `processing=${q.processingCount()}`);

    // Mark result success on alice.
    q.markResult('@alice', 'success');
    const c2 = q.counts();
    check('after success: unfollowed=1', c2.unfollowed === 1, `unfollowed=${c2.unfollowed}`);
    check('after success: queued=2', c2.queued === 2, `queued=${c2.queued}`);

    // popNext -> bob, mark failed.
    const next2 = q.popNext();
    check('popNext2 returns bob', next2.key === '@bob', `got=${next2.key}`);
    q.markResult('@bob', 'failed');
    const c3 = q.counts();
    check('after failed: failed=1', c3.failed === 1, `failed=${c3.failed}`);

    // popNext -> carol, mark skipped.
    const next3 = q.popNext();
    check('popNext3 returns carol', next3.key === '@carol', `got=${next3.key}`);
    q.markResult('@carol', 'skipped');
    const c4 = q.counts();
    check('after skipped: skipped=1', c4.skipped === 1, `skipped=${c4.skipped}`);

    // All accounts are now removed from the queue.
    check('all processed', q.all().length === 0, `remaining=${q.all().length}`);
    check('processingCount=0', q.processingCount() === 0, `processing=${q.processingCount()}`);
  }

  // ---------- Order preservation and peek semantics ----------
  {
    const q = createQueue();
    q.add({ key: '@z', handle: 'z', displayName: 'Z' });
    q.add({ key: '@a', handle: 'a', displayName: 'A' });
    q.add({ key: '@m', handle: 'm', displayName: 'M' });

    // peek does not mutate state.
    const peek1 = q.peek();
    check('peek returns first in insertion order', peek1.key === '@z', `peek1=${peek1.key}`);

    // popNext returns in insertion order.
    const pop1 = q.popNext();
    check('pop1=z', pop1.key === '@z', `pop1=${pop1.key}`);
    q.markResult('@z', 'success');

    // Next peek/pop returns @a.
    const peek2 = q.peek();
    check('peek2=a', peek2.key === '@a', `peek2=${peek2.key}`);
    const pop2 = q.popNext();
    check('pop2=a', pop2.key === '@a', `pop2=${pop2.key}`);
    q.markResult('@a', 'success');

    const pop3 = q.popNext();
    check('pop3=m', pop3.key === '@m', `pop3=${pop3.key}`);
    q.markResult('@m', 'skipped');
  }

  return { name: 'queue-states', pass: passed, fail: failed, errors: failures };
}
