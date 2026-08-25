/**
 * @file discovery.js
 *
 * Discovery engine (PRD §7). Scans the currently-rendered DOM for account
 * cells, deduplicates them through the queue, and drives the scroll
 * controller forward until the list is exhausted.
 *
 * Responsibilities:
 *   - findAccountCells via XAdapter
 *   - extract identity for each cell, skip unidentifiable ones
 *   - enqueue new identities; never enqueue duplicates
 *   - drive the scroll controller so discoverAll() can walk the full list
 *
 * Non-responsibilities:
 *   - clicking the unfollow button (handled by unfollow.js)
 *   - rate limiting (handled by rate-controller.js)
 *   - persistence (handled by the background worker + storage.session)
 *
 * All DOM access is funneled through XAdapter. This module never queries
 * selectors directly.
 */

import { XAdapter } from './x-adapter.js';
import { createQueue } from './queue.js';
// ---------- Local scroll controller ----------
//
// This file's import surface is fixed to x-adapter.js and queue.js only,
// so the scroll controller is defined locally rather than imported. It
// uses the same primitives as the shared scroll module
// (XAdapter.scrollFollowingList + XAdapter.waitForDomMutation) and
// implements the standard idle-cycle exhaustion pattern.

const DEFAULT_IDLE_THRESHOLD = 3;
const DEFAULT_SCROLL_DELAY_MS = 400;
const DEFAULT_MUTATION_TIMEOUT_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createScrollController({
  idleThreshold = DEFAULT_IDLE_THRESHOLD,
  scrollDelayMs = DEFAULT_SCROLL_DELAY_MS,
  mutationTimeoutMs = DEFAULT_MUTATION_TIMEOUT_MS,
} = {}) {
  let baseline = -1;          // -1 == never initialised
  let lastCount = 0;
  let exhausted = false;

  async function scrollOnce() {
    XAdapter.scrollFollowingList();
    if (scrollDelayMs > 0) await sleep(scrollDelayMs);
    await XAdapter.waitForDomMutation(mutationTimeoutMs);
    lastCount = XAdapter.findAccountCells().length;
    return { newCellsRendered: lastCount };
  }

  return {
    async scrollOnce() {
      return scrollOnce();
    },

    async waitForNewAccounts(maxIdleCycles = idleThreshold) {
      const threshold = maxIdleCycles;
      let idle = 0;
      let cycles = 0;

      if (baseline < 0) baseline = XAdapter.findAccountCells().length;

      while (idle < threshold) {
        cycles += 1;
        const { newCellsRendered } = await scrollOnce();
        if (newCellsRendered > baseline) {
          baseline = newCellsRendered;
          idle = 0;
          return { exhausted: false, cycles };
        }
        idle += 1;
      }

      exhausted = true;
      return { exhausted: true, cycles };
    },

    isExhausted() {
      return exhausted;
    },

    lastCellCount() {
      return lastCount;
    },

    reset() {
      baseline = -1;
      lastCount = 0;
      exhausted = false;
    },
  };
}

// ---------- Discovery engine ----------

/**
 * Build a discovery engine. Optional dependency injection is honored so
 * the wiring in content.js can share a single queue and scroll controller
 * instance with unfollow.js and the status panel.
 *
 * @param {object} [deps]
 * @param {object} [deps.queue]            - a queue returned by createQueue().
 *                                            Constructed fresh when omitted.
 * @param {object} [deps.scrollController] - a scroll controller instance.
 *                                            Constructed fresh when omitted.
 * @returns {{
 *   discoverVisible: () => { found: number, added: number, totalInDom: number },
 *   discoverAll:     () => Promise<{ exhausted: boolean, cycles: number, discovered: number }>,
 *   queue:  () => object,
 *   scroll: () => object,
 * }}
 */
function createDiscovery({ queue, scrollController } = {}) {
  const q = queue || createQueue();
  const sc = scrollController || createScrollController();

  return {
    /**
     * Scan the DOM once. For every account cell with a parseable identity,
     * attempt to enqueue it. Returns a counter object so callers can:
     *   - know whether work was found in this pass
     *   - know how many of those were net-new vs duplicates
     *   - know the raw cell count (cells lacking an identity are skipped
     *     silently, but their presence is observable for diagnostics).
     *
     * @returns {{ found: number, added: number, totalInDom: number }}
     */
    discoverVisible() {
      const cells = XAdapter.findAccountCells();
      let found = 0;
      let added = 0;
      for (const cell of cells) {
        const identity = XAdapter.getAccountIdentity(cell);
        if (identity === null || identity === undefined) continue;
        found += 1;
        if (q.add(identity)) added += 1;
      }
      return { found, added, totalInDom: cells.length };
    },

    /**
     * Walk the entire Following list (ALL mode).
     *
     * Algorithm (PRD §7):
     *   1. discoverVisible() -- enqueue whatever is rendered.
     *   2. waitForNewAccounts() -- drive the scroll controller; resolves
     *      with { exhausted, cycles }.
     *   3. If exhausted, stop; otherwise loop.
     *
     * The scroll controller resolves exhausted=true only after
     * maxIdleCycles consecutive idle scroll attempts, so this loop
     * naturally terminates at the bottom of the list.
     *
     * Note: this method only populates the queue. The unfollow engine
     * (unfollow.js) is the consumer; content.js wires them together.
     *
     * @returns {Promise<{ exhausted: boolean, cycles: number, discovered: number }>}
     */
    async discoverAll() {
      let totalCycles = 0;
      let lastWait = { exhausted: false, cycles: 0 };
      let exhausted = false;

      while (!exhausted) {
        // 1) enqueue whatever is on screen right now.
        this.discoverVisible();

        // 2) ask the scroll controller for the next batch. It resolves
        //    either when new cells rendered (exhausted:false) or when
        //    the bottom of the list was reached (exhausted:true).
        lastWait = await sc.waitForNewAccounts();
        totalCycles += lastWait.cycles;
        exhausted = lastWait.exhausted;
      }

      // One final pass at the bottom of the list -- useful if the last
      // mutation batch landed cells that hadn't been enqueued yet.
      this.discoverVisible();

      return {
        exhausted,
        cycles: totalCycles,
        discovered: q.counts().discovered,
      };
    },

    /** Accessor for the underlying queue (status snapshots, peek, etc.). */
    queue() {
      return q;
    },

    /** Accessor for the underlying scroll controller. */
    scroll() {
      return sc;
    },
  };
}

export { createDiscovery };
export default createDiscovery;
