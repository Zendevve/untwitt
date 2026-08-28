// Suite: safety-governor
//
// Proves the safety governor:
//   - Jitter: delay variation within configured percentage bounds
//   - Daily quota: triggers pause on quota limit
//   - Circuit breaker: trips pause on consecutive failure threshold
//   - Reset and snapshot operations

import { createSafetyGovernor, DEFAULT_GOVERNOR_CONFIG } from '../../src/content/safety-governor.js';

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  // 1. Defaults
  check('default jitter is 0.3', DEFAULT_GOVERNOR_CONFIG.jitterPct === 0.3, `jitter=${DEFAULT_GOVERNOR_CONFIG.jitterPct}`);
  check('default quota is 400', DEFAULT_GOVERNOR_CONFIG.dailyQuota === 400, `quota=${DEFAULT_GOVERNOR_CONFIG.dailyQuota}`);

  // 2. Jitter range
  const gov = createSafetyGovernor({ jitterPct: 0.2 });
  const base = 1000;
  let allInRange = true;
  for (let i = 0; i < 50; i += 1) {
    const d = gov.applyDelay(base);
    if (d < 800 || d > 1200) {
      allInRange = false;
      break;
    }
  }
  check('50 jitter delays within 800-1200ms', allInRange === true, 'jitter delay out of bounds');

  // 3. Circuit breaker on failures
  let tripLogged = null;
  const breakerGov = createSafetyGovernor({
    failureThreshold: 3,
    onTrip: (info) => { tripLogged = info; },
  });

  check('initially not paused', breakerGov.isPaused() === false, 'initially paused');

  breakerGov.recordFailure();
  check('fail 1 not tripped', breakerGov.isPaused() === false, 'paused after 1');

  breakerGov.recordFailure();
  check('fail 2 not tripped', breakerGov.isPaused() === false, 'paused after 2');

  const tripRes = breakerGov.recordFailure();
  check('fail 3 tripped=true', tripRes.tripped === true, `tripped=${tripRes.tripped}`);
  check('isPaused=true after 3 fails', breakerGov.isPaused() === true, 'not paused');
  check('tripReason=circuit_breaker_tripped', breakerGov.tripReason() === 'circuit_breaker_tripped', `reason=${breakerGov.tripReason()}`);
  check('onTrip called with failure info', tripLogged && tripLogged.reason === 'circuit_breaker_tripped', `logged=${JSON.stringify(tripLogged)}`);

  // 4. Reset
  breakerGov.reset();
  check('reset clears pause', breakerGov.isPaused() === false, 'still paused after reset');
  check('reset clears tripReason', breakerGov.tripReason() === null, `reason=${breakerGov.tripReason()}`);

  // 5. Success resets failure streak
  breakerGov.recordFailure();
  breakerGov.recordFailure();
  breakerGov.recordSuccess();
  breakerGov.recordFailure();
  check('streak broken by success', breakerGov.isPaused() === false, 'paused unexpectedly');

  // 6. Snapshot
  const snap = breakerGov.snapshot();
  check('snapshot has failureThreshold', snap.failureThreshold === 3, `snap=${JSON.stringify(snap)}`);
  check('snapshot has consecutiveFailures=1', snap.consecutiveFailures === 1, `snap=${JSON.stringify(snap)}`);

  return { name: 'safety-governor', pass: passed, fail: failed, errors: failures };
}
