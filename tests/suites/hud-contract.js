// Suite: hud-contract
//
// Proves the HUD overlay:
//   - DOM construction with data-untwitt-hud
//   - Dynamic state and counter rendering
//   - Toggle collapse/expand button
//   - Teardown on destroy()

import { withFixture } from '../fixtures/x-dom.js';
import { createHud } from '../../src/content/hud.js';

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  await withFixture({ accounts: [{ handle: 'test', displayName: 'Test' }] }, async (window, document) => {
    const hud = createHud({ parent: document.body, position: 'bottom-right' });

    // 1. Initial render
    hud.render({
      state: 'IDLE',
      unfollowedCount: 0,
      detectedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      mode: 'all',
      speed: 'normal',
      recent: [],
    });

    const el = hud.element();
    check('hud root exists in document', !!el && el.isConnected, 'no connected root');
    check('hud has data-untwitt-hud attribute', el.getAttribute('data-untwitt-hud') === 'true', 'attr missing');
    check('hud position is bottom-right', el.getAttribute('data-position') === 'bottom-right', 'wrong pos');

    const stateEl = el.querySelector('.state');
    check('state badge text is IDLE', stateEl && stateEl.textContent === 'IDLE', `stateText=${stateEl && stateEl.textContent}`);

    const counterEl = el.querySelector('.counter');
    check('counter text is 0', counterEl && counterEl.textContent === '0', `counter=${counterEl && counterEl.textContent}`);

    // 2. Updated render during execution
    hud.render({
      state: 'RUNNING',
      unfollowedCount: 7,
      detectedCount: 20,
      skippedCount: 3,
      failedCount: 1,
      mode: 'non_followers',
      speed: 'fast',
      recent: [
        { type: 'ACCOUNT_UNFOLLOWED', account: { handle: 'alice' } },
        { type: 'ACCOUNT_SKIPPED', account: { handle: 'bob' } },
      ],
    });

    check('state badge updated to RUNNING', stateEl.textContent === 'RUNNING', `state=${stateEl.textContent}`);
    check('counter updated to 7', counterEl.textContent === '7', `counter=${counterEl.textContent}`);

    const sublineEl = el.querySelector('.subline');
    check('subline contains detected 20', sublineEl && sublineEl.textContent.includes('detected 20'), `subline=${sublineEl && sublineEl.textContent}`);

    const logRows = el.querySelectorAll('.log-row');
    check('log has 2 rows rendered', logRows.length === 2, `rows=${logRows.length}`);
    check('first log row mentions @alice', logRows[0].textContent.includes('@alice'), `row0=${logRows[0].textContent}`);

    // 3. Toggle button collapses HUD
    const toggleBtn = el.querySelector('.toggle');
    check('toggle button exists', !!toggleBtn, 'missing toggle');

    toggleBtn.click();
    check('collapsed attribute set after click', el.getAttribute('data-collapsed') === 'true', 'not collapsed');
    check('toggle button changed to +', toggleBtn.textContent === '+', `btnText=${toggleBtn.textContent}`);

    toggleBtn.click();
    check('collapsed attribute removed on second click', el.getAttribute('data-collapsed') === null, 'still collapsed');
    check('toggle button changed back to −', toggleBtn.textContent === '−', `btnText=${toggleBtn.textContent}`);

    // 4. Destroy cleanly removes from DOM
    hud.destroy();
    check('hud element removed from document after destroy', document.querySelector('[data-untwitt-hud]') === null, 'element still in DOM');
  });

  return { name: 'hud-contract', pass: passed, fail: failed, errors: failures };
}
