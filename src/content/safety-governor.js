/**
 * @file safety-governor.js
 *
 * Anti-ban safety governor. Wraps a base delay with randomized jitter,
 * enforces a daily quota, and trips a circuit breaker after consecutive
 * failures. Pure ES module, no DOM, no chrome.* APIs.
 */

/**
 * Default governor configuration.
 *   - jitterPct: ±0.3 means delay is varied by up to ±30% of the base.
 *   - dailyQuota: max successful unfollows per UTC day before pause.
 *   - failureThreshold: consecutive failures that trip the breaker.
 *   - onTrip: optional callback invoked exactly once per trip.
 */
export const DEFAULT_GOVERNOR_CONFIG = Object.freeze({
  jitterPct: 0.3,
  dailyQuota: 400,
  failureThreshold: 3,
  onTrip: null,
});

/**
 * Creates a new safety governor.
 *
 * @param {object} [config]
 * @returns {{
 *   applyDelay: (baseMs: number) => number,
 *   recordSuccess: () => void,
 *   recordFailure: () => { tripped: boolean, consecutiveFailures: number },
 *   reset: () => void,
 *   isPaused: () => boolean,
 *   tripReason: () => string|null,
 *   snapshot: () => object,
 *   setDailyQuota: (n: number) => void,
 *   setJitterPct: (pct: number) => void,
 * }}
 */
export function createSafetyGovernor(config = {}) {
  const opts = { ...DEFAULT_GOVERNOR_CONFIG, ...config };
  let jitter = clampPct(opts.jitterPct);
  let quota = Math.max(0, Math.trunc(Number(opts.dailyQuota) || 0));
  let threshold = Math.max(1, Math.trunc(Number(opts.failureThreshold) || 3));
  const onTrip = typeof opts.onTrip === 'function' ? opts.onTrip : null;

  let successCount = 0;
  let consecutiveFailures = 0;
  let paused = false;
  let pauseReason = null;
  let cooldownUntil = 0;
  let lastJitterMs = 0;
  const dayKey = utcDayKey(new Date());
  let daySuccessCount = 0;
  function applyDelay(baseMs) {
    if (paused) return 0;
    const base = Math.max(0, Math.trunc(Number(baseMs) || 0));
    const variation = base * jitter;
    const offset = (Math.random() * 2 - 1) * variation;
    const result = Math.max(0, Math.round(base + offset));
    lastJitterMs = result;
    return result;
  }

  function recordSuccess() {
    successCount += 1;
    consecutiveFailures = 0;
    rollDay();
    if (quota > 0 && daySuccessCount >= quota) {
      paused = true;
      pauseReason = 'daily_quota_reached';
      if (onTrip) {
        try { onTrip({ reason: pauseReason, daySuccessCount, quota }); } catch (_) { /* ignore */ }
      }
    }
  }

  function recordFailure() {
    consecutiveFailures += 1;
    if (consecutiveFailures >= threshold && !paused) {
      paused = true;
      pauseReason = 'circuit_breaker_tripped';
      if (onTrip) {
        try { onTrip({ reason: pauseReason, consecutiveFailures, threshold }); } catch (_) { /* ignore */ }
      }
      return { tripped: true, consecutiveFailures };
    }
    return { tripped: false, consecutiveFailures };
  }

  function recordRateLimitHit(cooldownMs = 15 * 60 * 1000) {
    paused = true;
    pauseReason = 'rate_limited';
    cooldownUntil = Date.now() + Math.max(1000, Number(cooldownMs) || 15 * 60 * 1000);
    if (onTrip) {
      try { onTrip({ reason: pauseReason, cooldownUntil }); } catch (_) { /* ignore */ }
    }
  }

  function getCooldownRemaining() {
    if (cooldownUntil <= 0) return 0;
    const remaining = cooldownUntil - Date.now();
    if (remaining <= 0) {
      cooldownUntil = 0;
      if (paused && pauseReason === 'rate_limited') {
        paused = false;
        pauseReason = null;
        consecutiveFailures = 0;
      }
      return 0;
    }
    return remaining;
  }

  function reset() {
    successCount = 0;
    consecutiveFailures = 0;
    paused = false;
    pauseReason = null;
    cooldownUntil = 0;
    lastJitterMs = 0;
    daySuccessCount = 0;
  }

  function isPaused() {
    if (cooldownUntil > 0) {
      if (getCooldownRemaining() > 0) return true;
    }
    rollDay();
    if (paused && pauseReason === 'daily_quota_reached') {
      const now = utcDayKey(new Date());
      if (now !== dayKey) {
        paused = false;
        pauseReason = null;
        daySuccessCount = 0;
      }
    }
    return paused;
  }

  function tripReason() {
    return pauseReason;
  }

  function rollDay() {
    const now = utcDayKey(new Date());
    if (now !== dayKey) {
      dayKey = now;
      daySuccessCount = 0;
    }
  }

  function snapshot() {
    rollDay();
    return {
      jitterPct: jitter,
      dailyQuota: quota,
      failureThreshold: threshold,
      successCount,
      consecutiveFailures,
      paused: isPaused(),
      pauseReason,
      cooldownRemainingMs: getCooldownRemaining(),
      daySuccessCount,
      lastJitterMs,
    };
  }

  function setDailyQuota(n) {
    quota = Math.max(0, Math.trunc(Number(n) || 0));
  }

  function setJitterPct(pct) {
    jitter = clampPct(pct);
  }

  return {
    applyDelay,
    recordSuccess,
    recordFailure,
    recordRateLimitHit,
    getCooldownRemaining,
    reset,
    isPaused,
    tripReason,
    snapshot,
    setDailyQuota,
    setJitterPct,
  };
}

function clampPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function utcDayKey(d) {
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}

export default {
  DEFAULT_GOVERNOR_CONFIG,
  createSafetyGovernor,
};
