// Suite: adaptive-slowdown
//
// Proves the rateController sequence for the `fast` preset (1500ms
// baseline, chosen to stay under X's per-account unfollow rate limit).
// Multiplier is 1 + backoffSteps * 0.5, capped at 4. Curve:
//   steps=0: 1500
//   steps=1: 2250
//   steps=2: 3000
//   steps=3: 3750
//   steps=4: 4500
//   steps=5: 5250
//   steps=6: 6000
//   steps=7: 6000 (cap)
// Then adaptiveReset() zeroes backoffSteps, returning to 1500.

import { createRateController } from '../../src/content/rate-controller.js';

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  const rc = createRateController();
  rc.setPreset('fast');
  check('preset=fast', rc.preset() === 'fast', `preset=${rc.preset()}`);
  check('baseline=1500', rc.snapshot().baselineMs === 1500, `baselineMs=${rc.snapshot().baselineMs}`);

  // steps=0
  check('initial delay=1500', rc.getDelay() === 1500, `got=${rc.getDelay()}`);

  // backoff once
  rc.adaptiveBackoff();
  check('after 1 backoff=2250', rc.getDelay() === 2250, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 2 backoff=3000', rc.getDelay() === 3000, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 3 backoff=3750', rc.getDelay() === 3750, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 4 backoff=4500', rc.getDelay() === 4500, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 5 backoff=5250', rc.getDelay() === 5250, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 6 backoff=6000', rc.getDelay() === 6000, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 7 backoff=6000 (cap)', rc.getDelay() === 6000, `got=${rc.getDelay()}`);

  // reset
  rc.adaptiveReset();
  check('after reset=1500', rc.getDelay() === 1500, `got=${rc.getDelay()}`);
  check('snapshot multiplier=1', rc.snapshot().multiplier === 1, `multiplier=${rc.snapshot().multiplier}`);

  return { name: 'adaptive-slowdown', pass: passed, fail: failed, errors: failures };
}
