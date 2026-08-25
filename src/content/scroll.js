/**
 * @file scroll.js
 *
 * Scroll controller for the untwitt content script. Drives the X "Following"
 * list: scrolls a step, waits for the next DOM mutation, and reports how many
 * account cells are now in the DOM. A separate `waitForNewAccounts` loop
 * tracks consecutive idle cycles to decide when the list is exhausted and the
 * engine should stop.
 *
 * All DOM access goes through the XAdapter interface imported from
 * x-adapter.js. This module never reaches into the document directly and
 * never embeds raw selectors.
 *
 * Safe under missing `document`/`window`: every method that ultimately calls
 * an adapter method wraps the call in a try/catch and returns a safe default,
 * so construction and the no-op paths behave correctly in a Node test
 * environment.
 */

import { XAdapter } from './x-adapter.js';

const DEFAULT_IDLE_THRESHOLD = 3;
const DEFAULT_SCROLL_STEP_PX = 600;
const DEFAULT_MUTATION_TIMEOUT_MS = 4000;

/**
 * Create a scroll controller instance.
 *
 * @param {object} [opts]
 * @param {number} [opts.idleThreshold=3]    Default ceiling for
 *   `waitForNewAccounts`; the method accepts an override per call.
 * @param {number} [opts.scrollStepPx=600]  Reserved for future per-instance
 *   scroll step tuning. The current XAdapter API scrolls a fixed 600px, but
 *   the value is recorded here so the controller's public surface matches
 *   the spec and is ready to be threaded through once the adapter supports
 *   a configurable step.
 * @param {number} [opts.mutationTimeoutMs=4000] Default ceiling for the
 *   MutationObserver wait inside `scrollOnce`.
 * @returns {{
 *   scrollOnce: () => Promise<{ newCellsRendered: number }>,
 *   waitForNewAccounts: (maxIdleCycles?: number) => Promise<{ exhausted: boolean, cycles: number }>,
 *   isExhausted: () => boolean,
 *   lastCellCount: () => number,
 *   reset: () => void,
 * }}
 */
export function createScrollController({
  idleThreshold = DEFAULT_IDLE_THRESHOLD,
  scrollStepPx = DEFAULT_SCROLL_STEP_PX,
  mutationTimeoutMs = DEFAULT_MUTATION_TIMEOUT_MS,
} = {}) {
  if (!Number.isFinite(idleThreshold) || idleThreshold < 1) {
    throw new TypeError('createScrollController: idleThreshold must be a positive number');
  }
  if (!Number.isFinite(scrollStepPx) || scrollStepPx <= 0) {
    throw new TypeError('createScrollController: scrollStepPx must be a positive number');
  }
  if (!Number.isFinite(mutationTimeoutMs) || mutationTimeoutMs <= 0) {
    throw new TypeError('createScrollController: mutationTimeoutMs must be a positive number');
  }

  // The previous cell-count baseline, used by `waitForNewAccounts` to
  // decide whether a cycle produced growth.
  let _prevCellCount = 0;

  // The most recent cell count observed by `scrollOnce`.
  let _lastCellCount = 0;

  // Result of the most recent `waitForNewAccounts` call. `null` means
  // `waitForNewAccounts` has not run yet.
  let _exhausted = null;

  // Number of cycles executed by the most recent `waitForNewAccounts`
  // call. Useful for telemetry and tests.
  let _lastCycleCount = 0;

  function safeCount() {
    try {
      const cells = XAdapter.findAccountCells();
      return Array.isArray(cells) ? cells.length : 0;
    } catch (_) {
      return 0;
    }
  }

  async function scrollOnce() {
    try {
      XAdapter.scrollFollowingList();
    } catch (_) {
      // Scrolling is best-effort; continue regardless.
    }

    // Wait for the next DOM mutation, but never block forever. The adapter
    // resolves on either the first mutation batch or the timeout, so this
    // await is bounded.
    try {
      await XAdapter.waitForDomMutation(mutationTimeoutMs);
    } catch (_) {
      // The adapter contract says it never rejects; this is a defensive
      // guard so a future adapter that does throw cannot wedge the loop.
    }

    const count = safeCount();
    _lastCellCount = count;
    return { newCellsRendered: count };
  }

  async function waitForNewAccounts(maxIdleCycles = idleThreshold) {
    if (!Number.isFinite(maxIdleCycles) || maxIdleCycles < 1) {
      throw new TypeError('waitForNewAccounts: maxIdleCycles must be a positive number');
    }

    let consecutiveIdle = 0;
    let cycles = 0;

    // Seed the baseline with the current DOM so the very first cycle has a
    // meaningful "previous count" to compare against. If the DOM is
    // unavailable, the baseline stays at 0 and the first cycle will count
    // as growth the moment any cells appear.
    _prevCellCount = safeCount();
    _lastCellCount = _prevCellCount;
    _exhausted = false;

    while (consecutiveIdle < maxIdleCycles) {
      cycles += 1;
      const { newCellsRendered } = await scrollOnce();

      // A cycle is "idle" when the cell count did not grow past the
      // baseline we recorded at the start of this cycle. The "no mutation
      // fired" branch of the spec reduces to the same observable outcome:
      // no new cells were rendered, so the count is unchanged.
      if (newCellsRendered <= _prevCellCount) {
        consecutiveIdle += 1;
        _exhausted = consecutiveIdle >= maxIdleCycles;
        if (_exhausted) break;
        // Keep the baseline pinned at the last-seen count so subsequent
        // idle cycles compare against the same value; this prevents a
        // single flake from prematurely exiting the loop.
        continue;
      }

      // Growth: reset the idle counter and update the baseline.
      consecutiveIdle = 0;
      _exhausted = false;
      _prevCellCount = newCellsRendered;
    }

    _lastCycleCount = cycles;
    return { exhausted: !!_exhausted, cycles };
  }

  function isExhausted() {
    return _exhausted === true;
  }

  function lastCellCount() {
    return _lastCellCount;
  }

  function reset() {
    _prevCellCount = 0;
    _lastCellCount = 0;
    _exhausted = null;
    _lastCycleCount = 0;
  }

  return {
    scrollOnce,
    waitForNewAccounts,
    isExhausted,
    lastCellCount,
    reset,
  };
}

export default createScrollController;
