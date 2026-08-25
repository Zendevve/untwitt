// Suite: adaptive-slowdown
//
// Proves the rateController sequence:
//   500 -> 750 -> 1000 -> 1250 -> 1500 -> 1750 -> 2000 -> 2000 (cap)
// matches the PRD's "fast preset + adaptive backoff" curve.
//
// The rateController uses a multiplier of 1 + backoffSteps * 0.5 capped
// at 4. With baselineMs=500 (fast), getDelay() returns:
//   steps=0: 500
//   steps=1: 750
//   steps=2: 1000
//   steps=3: 1250
//   steps=4: 1500
//   steps=5: 1750
//   steps=6: 2000
//   steps=7: 2000 (cap)
// Then adaptiveReset() zeroes backoffSteps, returning to 500.

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
  check('baseline=500', rc.snapshot().baselineMs === 500, `baselineMs=${rc.snapshot().baselineMs}`);

  // steps=0
  check('initial delay=500', rc.getDelay() === 500, `got=${rc.getDelay()}`);

  // backoff once
  rc.adaptiveBackoff();
  check('after 1 backoff=750', rc.getDelay() === 750, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 2 backoff=1000', rc.getDelay() === 1000, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 3 backoff=1250', rc.getDelay() === 1250, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 4 backoff=1500', rc.getDelay() === 1500, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 5 backoff=1750', rc.getDelay() === 1750, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 6 backoff=2000', rc.getDelay() === 2000, `got=${rc.getDelay()}`);

  rc.adaptiveBackoff();
  check('after 7 backoff=2000 (cap)', rc.getDelay() === 2000, `got=${rc.getDelay()}`);

  // reset
  rc.adaptiveReset();
  check('after reset=500', rc.getDelay() === 500, `got=${rc.getDelay()}`);
  check('snapshot multiplier=1', rc.snapshot().multiplier === 1, `multiplier=${rc.snapshot().multiplier}`);

  return { name: 'adaptive-slowdown', pass: passed, fail: failed, errors: failures };
}
