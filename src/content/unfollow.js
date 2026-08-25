// Unfollow engine: processes one queued account at a time through the
// XAdapter surface, records results on the queue, paces itself with the
// rate controller, and reports per-account outcomes to the popup.
//
// Contract:
//   createUnfollowEngine({ queue, rateController, confirmTimeoutMs, onEvent })
//     .processOne()       -> { status, account } | null
//     .processBatch(n)    -> { processed, success, failed, skipped }
//     .processAll(idleCheck) -> { processed, exhausted }
//
// All X DOM access is delegated to XAdapter. No raw selectors live here.

import { XAdapter } from './x-adapter.js';
import { createRateController } from './rate-controller.js';

const MAX_PROCESS_ALL_ITERATIONS = 10000;

function findCellForAccount(account) {
  const cells = XAdapter.findAccountCells();
  for (const cell of cells) {
    const identity = XAdapter.getAccountIdentity(cell);
    if (identity && identity.key === account.key) return cell;
  }
  return null;
}

function emit(onEvent, type, account) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent({ type, account });
  } catch (_) {
    // A misbehaving listener must never break the engine.
  }
}

export function createUnfollowEngine({
  queue,
  rateController,
  confirmTimeoutMs = 3000,
  onEvent = null,
} = {}) {
  const rc = rateController || createRateController();
  const q = queue;
  const confirmMs = confirmTimeoutMs;
  const listener = onEvent;

  async function processOne() {
    const account = q.popNext();
    if (!account) return null;

    let status;
    try {
      const cell = findCellForAccount(account);
      if (!cell) {
        status = 'skipped';
        q.markResult(account.key, status);
        emit(listener, 'ACCOUNT_SKIPPED', account);
      } else {
        const button = XAdapter.findUnfollowButton(cell);
        if (!button) {
          status = 'skipped';
          q.markResult(account.key, status);
          emit(listener, 'ACCOUNT_SKIPPED', account);
        } else {
          XAdapter.clickUnfollow(button);
          const confirmed = await XAdapter.confirmUnfollow(confirmMs);
          if (!confirmed) {
            status = 'failed';
            rc.adaptiveBackoff();
            q.markResult(account.key, status);
            emit(listener, 'ACCOUNT_FAILED', account);
          } else {
            status = 'success';
            rc.adaptiveReset();
            q.markResult(account.key, status);
            emit(listener, 'ACCOUNT_UNFOLLOWED', account);
          }
        }
      }
    } catch (_) {
      status = 'failed';
      rc.adaptiveBackoff();
      try { q.markResult(account.key, status); } catch (_) { /* ignore */ }
      emit(listener, 'ACCOUNT_FAILED', account);
    }

    await rc.sleep();
    return { status, account };
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
