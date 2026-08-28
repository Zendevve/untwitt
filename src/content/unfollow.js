// Unfollow engine: processes one queued account at a time through the
// XAdapter surface, records results on the queue, paces itself with the
// rate controller, and reports per-account outcomes to the popup.
//
// Contract:
//   createUnfollowEngine({ queue, rateController, confirmTimeoutMs, onEvent, filterConfig, whitelist })
//     .processOne()       -> { status, account, reason? } | null
//     .processBatch(n)    -> { processed, success, failed, skipped }
//     .processAll(idleCheck) -> { processed, exhausted }
//
// All X DOM access is delegated to XAdapter. No raw selectors live here.
// Filter evaluation (whitelist, reciprocity, verified, bio keywords,
// default avatar) is delegated to filter.js.

import { XAdapter } from './x-adapter.js';
import { createRateController } from './rate-controller.js';
import { evaluateAccount } from './filter.js';
import { createSafetyGovernor } from './safety-governor.js';

const MAX_PROCESS_ALL_ITERATIONS = 10000;

function findCellForAccount(account) {
  const cells = XAdapter.findAccountCells();
  for (const cell of cells) {
    const identity = XAdapter.getAccountIdentity(cell);
    if (identity && identity.key === account.key) return cell;
  }
  return null;
}

function emit(onEvent, type, account, extra) {
  if (typeof onEvent !== 'function') return;
  try {
    const payload = { type, account };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) payload[k] = extra[k];
    }
    onEvent(payload);
  } catch (_) {
    // A misbehaving listener must never break the engine.
  }
}

export function createUnfollowEngine({
  queue,
  rateController,
  confirmTimeoutMs = 3000,
  onEvent = null,
  filterConfig = null,
  whitelist = null,
  safetyGovernor = null,
} = {}) {
  const rc = rateController || createRateController();
  const q = queue;
  const confirmMs = confirmTimeoutMs;
  const listener = onEvent;
  const cfg = filterConfig;
  const wl = whitelist;
  const gov = safetyGovernor || null;

  async function processOne() {
    const account = q.popNext();
    if (!account) return null;

    // 1. Filter evaluation -- skip before any DOM work.
    if (cfg || wl) {
      const verdict = evaluateAccount(account, cfg || {}, wl);
      if (verdict && verdict.action === 'skip') {
        q.markResult(account.key, 'skipped');
        emit(listener, 'ACCOUNT_SKIPPED', account, { reason: verdict.reason || 'filtered' });
        return { status: 'skipped', account, reason: verdict.reason || 'filtered' };
      }
    }

    let status;
    let reason;
    try {
      let cell = findCellForAccount(account);
      if (!cell) {
        XAdapter.scrollFollowingList();
        await XAdapter.waitForDomMutation(500);
        cell = findCellForAccount(account);
      }
      if (!cell) {
        status = 'skipped';
        reason = 'cell_missing';
        q.markResult(account.key, status);
        emit(listener, 'ACCOUNT_SKIPPED', account, { reason });
      } else {
        if (typeof cell.scrollIntoView === 'function') {
          try { cell.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
        }
        const button = XAdapter.findUnfollowButton(cell);
        if (!button) {
          status = 'skipped';
          reason = 'no_unfollow_button';
          q.markResult(account.key, status);
          emit(listener, 'ACCOUNT_SKIPPED', account, { reason });
        } else {
          XAdapter.clickUnfollow(button);
          const confirmed = await XAdapter.confirmUnfollow(confirmMs);
          if (!confirmed) {
            status = 'failed';
            rc.adaptiveBackoff();
            if (gov) gov.recordFailure();
            q.markResult(account.key, status);
            emit(listener, 'ACCOUNT_FAILED', account);
          } else {
            status = 'success';
            rc.adaptiveReset();
            if (gov) gov.recordSuccess();
            q.markResult(account.key, status);
            emit(listener, 'ACCOUNT_UNFOLLOWED', account);
          }
        }
      }
    } catch (_) {
      status = 'failed';
      rc.adaptiveBackoff();
      if (gov) gov.recordFailure();
      try { q.markResult(account.key, status); } catch (_) { /* ignore */ }
      emit(listener, 'ACCOUNT_FAILED', account);
    }

    // Sleep uses the base delay (or jittered if governor is present).
    if (gov) {
      const baseDelay = rc.getDelay();
      const jittered = gov.applyDelay(baseDelay);
      if (jittered > 0) {
        await new Promise((resolve) => setTimeout(resolve, jittered));
      }
    } else {
      await rc.sleep();
    }
    const result = { status, account };
    if (reason) result.reason = reason;
    return result;
  }

  async function processBatch(n) {
    const target = Math.max(0, Math.trunc(Number(n) || 0));
    const tally = { processed: 0, success: 0, failed: 0, skipped: 0 };
    for (let i = 0; i < target; i += 1) {
      const result = await processOne();
      if (result === null) break;
      tally.processed += 1;
      tally[result.status] += 1;
    }
    return tally;
  }

  async function processAll(idleCheck) {
    const check = typeof idleCheck === 'function' ? idleCheck : null;
    let processed = 0;
    for (let i = 0; i < MAX_PROCESS_ALL_ITERATIONS; i += 1) {
      const result = await processOne();
      if (result !== null) {
        processed += 1;
        continue;
      }
      if (!check) return { processed, exhausted: false };
      let status;
      try {
        status = await check();
      } catch (_) {
        return { processed, exhausted: false };
      }
      if (status && status.exhausted) {
        return { processed, exhausted: true };
      }
      // idleCheck says not exhausted yet but queue drained transiently;
      // loop again — popNext will block on the next discovery push.
    }
    return { processed, exhausted: false };
  }

  return { processOne, processBatch, processAll };
}

export default createUnfollowEngine;
