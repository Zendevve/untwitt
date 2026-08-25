// Suite: discovery-dedupe
//
// Proves the discovery engine deduplicates accounts by handle. The
// dedupe key is "@" + lowercased handle. Counter increments only on
// first sight.

import { withFixture } from '../fixtures/x-dom.js';
import { createDiscovery } from '../../src/content/discovery.js';
import { createQueue } from '../../src/content/queue.js';

export async function run() {
  const pass = 0;
  const fail = 0;
  const errors = [];
  const failures = [];
  let passed = 0;
  let failed = 0;

  function check(name, cond, detail) {
    if (cond) {
      passed += 1;
    } else {
      failed += 1;
      failures.push({ name, detail: detail || '' });
    }
  }

  await withFixture(
    {
      accounts: [
        { handle: 'Alice', displayName: 'Alice' },
        { handle: 'bob', displayName: 'Bob' },
        { handle: 'Carol', displayName: 'Carol' },
      ],
    },
    async (window, document, helpers) => {
      const queue = createQueue();
      const discovery = createDiscovery({ queue });

      // First pass: enqueue all three.
      const first = discovery.discoverVisible();
      check('first pass found=3', first.found === 3, `found=${first.found}`);
      check('first pass added=3', first.added === 3, `added=${first.added}`);

      // Second pass: same DOM, nothing new.
      const second = discovery.discoverVisible();
      check('second pass found=3', second.found === 3, `found=${second.found}`);
      check('second pass added=0', second.added === 0, `added=${second.added}`);

      // Add a duplicate with different casing.
      helpers.appendAccount('ALICE', 'Alice 2');
      const third = discovery.discoverVisible();
      check('mixed-case duplicate added=0', third.added === 0, `added=${third.added}`);
      check('mixed-case duplicate found=4', third.found === 4, `found=${third.found}`);

      // Check dedupe keys are "@" + lowercase.
      const all = queue.all();
      const keys = all.map((a) => a.key).sort();
      check(
        'keys are @lowercase',
        JSON.stringify(keys) === JSON.stringify(['@alice', '@bob', '@carol']),
        `keys=${JSON.stringify(keys)}`,
      );

      // Add a new account.
      helpers.appendAccount('Dave', 'Dave');
      const fourth = discovery.discoverVisible();
      check('new account added=1', fourth.added === 1, `added=${fourth.added}`);

      // Discovered counter increments only on first sight (3 -> 4).
      const counts = queue.counts();
      check('discovered counter=4', counts.discovered === 4, `discovered=${counts.discovered}`);
    },
  );

  return {
    name: 'discovery-dedupe',
    pass: passed,
    fail: failed,
    errors: failures,
  };
}
