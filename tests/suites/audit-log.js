// Suite: audit-log
//
// Proves the audit log:
//   - Records events with timestamps and accounts
//   - Ring buffer capping at maxEntries
//   - CSV and JSON export formatting
//   - Filtering by event type

import { createAuditLog, DEFAULT_LOG_CONFIG } from '../../src/content/audit-log.js';

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  // 1. Basic recording
  let fakeTime = 100000;
  const log = createAuditLog({ maxEntries: 5, now: () => fakeTime });

  log.record('ACCOUNT_UNFOLLOWED', { key: '@alice', handle: 'alice', displayName: 'Alice' });
  fakeTime += 1000;
  log.record('ACCOUNT_SKIPPED', { key: '@bob', handle: 'bob', displayName: 'Bob' }, { reason: 'whitelisted' });
  fakeTime += 1000;
  log.record('ACCOUNT_FAILED', { key: '@carol', handle: 'carol', displayName: 'Carol' });

  check('log size=3', log.size() === 3, `size=${log.size()}`);
  const all = log.all();
  check('first entry is alice', all[0].account.handle === 'alice', `first=${JSON.stringify(all[0])}`);
  check('second entry has reason whitelisted', all[1].reason === 'whitelisted', `second=${JSON.stringify(all[1])}`);

  // 2. Ring buffer eviction at maxEntries=5
  for (let i = 0; i < 5; i += 1) {
    log.record('ACCOUNT_UNFOLLOWED', { key: `@u${i}`, handle: `u${i}`, displayName: `U ${i}` });
  }
  check('capped at maxEntries=5', log.size() === 5, `size=${log.size()}`);
  check('oldest evicted: first is now u0', log.all()[0].account.handle === 'u0', `first=${JSON.stringify(log.all()[0])}`);

  // 3. Filter by type
  const skipped = log.filter((e) => e.type === 'ACCOUNT_SKIPPED');
  check('filter returns 0 skipped after eviction', skipped.length === 0, `len=${skipped.length}`);

  const unfollowed = log.filter((e) => e.type === 'ACCOUNT_UNFOLLOWED');
  check('filter returns 5 unfollowed', unfollowed.length === 5, `len=${unfollowed.length}`);

  // 4. Export CSV & JSON
  const json = log.exportJson();
  const parsed = JSON.parse(json);
  check('exportJson produces valid JSON array of 5', Array.isArray(parsed) && parsed.length === 5, `parsedLen=${parsed.length}`);

  const csv = log.exportCsv();
  check('exportCsv contains headers', csv.startsWith('ts,type,reason,key,handle,displayName'), `csv=${csv.slice(0, 50)}`);
  check('exportCsv contains u0 row', csv.includes('@u0,u0,U 0'), `csv=${csv}`);
  // 5. Clear
  log.clear();
  check('size=0 after clear', log.size() === 0, `size=${log.size()}`);

  return { name: 'audit-log', pass: passed, fail: failed, errors: failures };
}
