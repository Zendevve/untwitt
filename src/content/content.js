/**
 * @file content.js
 *
 * Content-script orchestrator for untwitt. This is the single bridge
 * between the popup/background messaging layer and the engine modules.
 *
 * Architecture:
 *   popup  --(chrome.runtime messages)-->  content.js
 *   content.js  -->  x-adapter (DOM), discovery, unfollow, queue,
 *                    rate-controller, scroll
 *   content.js  --(chrome.runtime.sendMessage)-->  popup / background
 *
 * Responsibilities (PRD §7-§8):
 *   - own the per-page session state (running, paused, mode, speed,
 *     batchSize, counters, consecutiveFailures)
 *   - handle inbound START / PAUSE / RESUME / STOP / GET_STATUS /
 *     SET_SPEED / SET_MODE / SET_BATCH_SIZE messages
 *   - run the main loop: discover visible cells, hand them to the
 *     unfollow engine one at a time, pace through the rate controller,
 *     honor pause, stop on user demand or 3 consecutive failures
 *   - persist the session under chrome.storage.session (key "session"),
 *     with an in-memory fallback when the API is absent (Node test env)
 *
 * Non-responsibilities:
 *   - DOM selectors live exclusively in x-adapter.js
 *   - rate pacing lives exclusively in rate-controller.js
 *   - queue state machine lives exclusively in queue.js
 *   - per-button click logic lives exclusively in unfollow.js
 *
 * Safety:
 *   - No raw X selectors in this file.
 *   - No top-level DOM access. The script is safe to import under Node
 *     (e.g. in tests); only the bottom of the file wires chrome.runtime
 *     listeners, and that block is guarded by a document-presence check.
 */

import { XAdapter } from './x-adapter.js';
import { createQueue } from './queue.js';
import { createRateController } from './rate-controller.js';
import { createScrollController } from './scroll.js';
import { createDiscovery } from './discovery.js';
import { createUnfollowEngine } from './unfollow.js';
import { createAuditLog } from './audit-log.js';
import { createHud } from './hud.js';
import { createSafetyGovernor } from './safety-governor.js';
import { createWhitelist, DEFAULT_FILTER_CONFIG } from './filter.js';


// ---------- Module-level state ----------
const STORAGE_KEY = 'session';
const SESSION_PERSIST_KEY = STORAGE_KEY;
const CONSECUTIVE_FAILURE_LIMIT = 3;

const session = {
  running: false,
  paused: false,
  mode: 'all',
  speed: 'normal',
  batchSize: 50,
  customDelayMs: null,
  filterMode: 'all',
  protectMutuals: false,
  protectVerified: false,
  skipDefaultAvatars: false,
  bioKeywordsExclude: [],
  whitelist: [],
  jitterPct: 0.3,
  dailyQuota: 400,
  discoveredCount: 0,
  queuedCount: 0,
  unfollowedCount: 0,
  failedCount: 0,
  skippedCount: 0,
  elapsedMs: 0,
  lastError: null,
  consecutiveFailures: 0,
};

// ---------- Filter / whitelist / safety modules ----------
const whitelist = createWhitelist(session.whitelist);
const safetyGovernor = createSafetyGovernor({
  jitterPct: session.jitterPct,
  dailyQuota: session.dailyQuota,
  failureThreshold: CONSECUTIVE_FAILURE_LIMIT,
});
const auditLog = createAuditLog();
let hud = null;
function ensureHud() {
  if (hud) return hud;
  if (typeof document === 'undefined' || !document.body) return null;
  try {
    hud = createHud();
    return hud;
  } catch (_) {
    hud = null;
    return null;
  }
}


// ---------- Pause / resume coordination ----------
//
// `waitWhilePaused` resolves when the session leaves the paused state.
// `_resume()` resolves it; `_rejectPauseWaiter()` aborts the wait when
// STOP is pressed so the loop can exit promptly.

let _pauseWaiter = null;

function _setPauseWaiter() {
  if (_pauseWaiter) return _pauseWaiter;
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  _pauseWaiter = { promise, resolve: resolveFn, reject: rejectFn };
  return _pauseWaiter;
}

function _resumePauseWaiter() {
  if (!_pauseWaiter) return;
  const w = _pauseWaiter;
  _pauseWaiter = null;
  try { w.resolve(); } catch (_) { /* ignore */ }
}

function _rejectPauseWaiter() {
  if (!_pauseWaiter) return;
  const w = _pauseWaiter;
  _pauseWaiter = null;
  try { w.reject(new Error('session stopped')); } catch (_) { /* ignore */ }
}

async function waitWhilePaused() {
  if (!session.paused) return;
  const waiter = _setPauseWaiter();
  await waiter.promise;
}

// ---------- Storage helper ----------
//
// `getStorage()` returns an object with `get(key)` and `set(key, value)`
// methods. It prefers chrome.storage.session (per PRD §13). When the
// chrome.* API is unavailable (e.g. in a Node test harness), it falls
// back to an in-memory shim so the rest of the script continues to
// function.

function getStorage() {
  const chromeApi = (typeof chrome !== 'undefined' && chrome && chrome.storage)
    ? chrome
    : (typeof globalThis !== 'undefined' && globalThis.chrome && globalThis.chrome.storage)
      ? globalThis.chrome
      : null;
  const sessionApi = chromeApi && chromeApi.storage && chromeApi.storage.session;

  if (sessionApi && typeof sessionApi.get === 'function' && typeof sessionApi.set === 'function') {
    return {
      available: true,
      async get(key) {
        try {
          return await new Promise((resolve, reject) => {
            try {
              sessionApi.get(key, (value) => {
                const err = chromeApi.runtime && chromeApi.runtime.lastError;
                if (err) reject(err); else resolve(value);
              });
            } catch (e) { reject(e); }
          });
        } catch (_) {
          return {};
        }
      },
      async set(key, value) {
        try {
          await new Promise((resolve, reject) => {
            try {
              sessionApi.set({ [key]: value }, () => {
                const err = chromeApi.runtime && chromeApi.runtime.lastError;
                if (err) reject(err); else resolve();
              });
            } catch (e) { reject(e); }
          });
          return true;
        } catch (_) {
          return false;
        }
      },
    };
  }

  // In-memory shim. Adequate for tests; cleared on full page reload.
  const memStore = (getStorage._memStore = getStorage._memStore || new Map());
  return {
    available: false,
    async get(key) {
      return memStore.has(key) ? { [key]: memStore.get(key) } : {};
    },
    async set(key, value) {
      memStore.set(key, value);
      return true;
    },
  };
}

async function persistSession() {
  try {
    const storage = getStorage();
    await storage.set(SESSION_PERSIST_KEY, _snapshotSession());
  } catch (_) {
    // Persistence is best-effort. The in-memory session is authoritative.
  }
}

function _snapshotSession() {
  return {
    running: session.running,
    paused: session.paused,
    mode: session.mode,
    speed: session.speed,
    batchSize: session.batchSize,
    customDelayMs: session.customDelayMs,
    discoveredCount: session.discoveredCount,
    queuedCount: session.queuedCount,
    unfollowedCount: session.unfollowedCount,
    failedCount: session.failedCount,
    skippedCount: session.skippedCount,
    elapsedMs: session.elapsedMs,
    lastError: session.lastError,
    consecutiveFailures: session.consecutiveFailures,
  };
}

async function loadPersistedSession() {
  try {
    const storage = getStorage();
    const got = await storage.get(SESSION_PERSIST_KEY);
    const stored = got && got[SESSION_PERSIST_KEY];
    if (!stored || typeof stored !== 'object') return;
    // Restore counters so the UI shows accurate numbers. Never auto-resume.
    if (Number.isFinite(stored.batchSize) && stored.batchSize > 0) session.batchSize = stored.batchSize;
    if (typeof stored.mode === 'string') session.mode = stored.mode;
    if (typeof stored.speed === 'string') session.speed = stored.speed;
    if (stored.customDelayMs === null || Number.isFinite(stored.customDelayMs)) {
      session.customDelayMs = stored.customDelayMs;
    }
    if (Number.isFinite(stored.discoveredCount)) session.discoveredCount = stored.discoveredCount;
    if (Number.isFinite(stored.queuedCount)) session.queuedCount = stored.queuedCount;
    if (Number.isFinite(stored.unfollowedCount)) session.unfollowedCount = stored.unfollowedCount;
    if (Number.isFinite(stored.failedCount)) session.failedCount = stored.failedCount;
    if (Number.isFinite(stored.skippedCount)) session.skippedCount = stored.skippedCount;
    if (Number.isFinite(stored.elapsedMs)) session.elapsedMs = stored.elapsedMs;
    session.running = false;
    session.paused = false;
    session.consecutiveFailures = 0;
    session.lastError = null;
  } catch (_) {
    // Best-effort restore.
  }
}

// ---------- Outbound messaging ----------

function _chromeRuntime() {
  if (typeof chrome !== 'undefined' && chrome && chrome.runtime) return chrome;
  if (typeof globalThis !== 'undefined' && globalThis.chrome && globalThis.chrome.runtime) return globalThis.chrome;
  return null;
}

function sendOutbound(message) {
  if (!message || typeof message !== 'object') return;
  const api = _chromeRuntime();
  if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') return;
  try {
    api.runtime.sendMessage(message, () => {
      // Swallow lastError so a closed popup does not surface as an
      // unhandled rejection. The runtime surfaces it via
      // chrome.runtime.lastError, which we deliberately ignore.
      const err = api.runtime.lastError;
      void err;
    });
  } catch (_) {
    // Outbound failures are never fatal to the engine.
  }
}

function emitStatus() {
  sendOutbound({
    type: 'STATUS',
    payload: _snapshotSession(),
  });
}

function emitEvent(type, account, extra) {
  try {
    auditLog.record(type, account, extra || {});
  } catch (_) { /* audit failures never break the loop */ }
  sendOutbound({
    type,
    payload: {
      key: account && account.key,
      handle: account && account.handle,
      displayName: account && account.displayName,
      ...(extra && typeof extra === 'object' ? extra : {}),
    },
  });
  _renderHudFromSession();
}

function _renderHudFromSession() {
  const h = ensureHud();
  if (!h) return;
  const recent = auditLog.all().slice(-8).reverse();
  const stateLabel = session.running
    ? (session.paused ? 'PAUSED' : 'RUNNING')
    : (session.lastError ? 'ERROR' : 'IDLE');
  h.render({
    state: stateLabel,
    unfollowedCount: session.unfollowedCount,
    detectedCount: session.discoveredCount,
    skippedCount: session.skippedCount,
    failedCount: session.failedCount,
    mode: session.mode,
    speed: session.speed,
    recent,
  });
}

function emitError(reason) {
  auditLog.record('ERROR', null, { reason: typeof reason === 'string' ? reason : 'unknown' });
  sendOutbound({
    type: 'ERROR',
    payload: {
      reason: typeof reason === 'string' ? reason : 'unknown',
      session: _snapshotSession(),
    },
  });
  _renderHudFromSession();
}

function emitCompleted(reason) {
  auditLog.record('COMPLETED', null, { reason: typeof reason === 'string' ? reason : 'finished' });
  sendOutbound({
    type: 'COMPLETED',
    payload: {
      reason: typeof reason === 'string' ? reason : 'finished',
      session: _snapshotSession(),
    },
  });
  _renderHudFromSession();
}

// ---------- Engine wiring ----------

const queue = createQueue();
const rateController = createRateController();
const scrollController = createScrollController();

const discovery = createDiscovery({ queue, scrollController });
const unfollow = createUnfollowEngine({
  queue,
  rateController,
  filterConfig: { ...DEFAULT_FILTER_CONFIG, filterMode: session.filterMode, protectMutuals: session.protectMutuals, protectVerified: session.protectVerified, bioKeywordsExclude: session.bioKeywordsExclude, skipDefaultAvatars: session.skipDefaultAvatars },
  whitelist,
  safetyGovernor,
  onEvent: (e) => emitEvent(e.type, e.account, { reason: e.reason }),
});
// Initialize the rate controller from the persisted speed, if any.
if (session.speed === 'custom' && session.customDelayMs != null) {
  rateController.setCustomDelay(session.customDelayMs);
  rateController.setPreset('custom');
} else if (typeof session.speed === 'string') {
  rateController.setPreset(session.speed);
}

// ---------- Counters ----------

function _pullCounters() {
  const counts = queue.counts();
  session.discoveredCount = counts.discovered;
  session.queuedCount = counts.queued;
  session.unfollowedCount = counts.unfollowed;
  session.failedCount = counts.failed;
  session.skippedCount = counts.skipped;
}

function _processedInBatch() {
  return session.unfollowedCount + session.failedCount + session.skippedCount;
}

// ---------- Main loop ----------

let _loopPromise = null;

async function processOneWithPause() {
  // Pause check before pulling the next account.
  if (session.paused) await waitWhilePaused();
  if (!session.running) return null;

  const result = await unfollow.processOne();
  if (result === null) return null;

  // The unfollow engine already invoked rc.sleep(); honor pause once
  // more before the next iteration so a PAUSE pressed mid-batch
  // freezes promptly.
  if (session.paused) await waitWhilePaused();
  if (!session.running) return null;

  if (result.status === 'success') {
    session.consecutiveFailures = 0;
  } else if (result.status === 'failed') {
    session.consecutiveFailures += 1;
  }
  // 'skipped' is intentionally neutral; it does not reset or increment
  // the consecutive-failure counter.
  return result;
}

async function runLoop() {
  const startedAt = Date.now();
  let batchReachedTarget = false;

  try {
    while (session.running) {
      // Discovery pass: enqueue whatever is currently visible.
      const dresult = discovery.discoverVisible();
      _pullCounters();
      if (dresult.added > 0) {
        emitStatus();
      }
      await persistSession();

      if (!session.running) break;

      if (session.mode === 'batch') {
        const processedBefore = _processedInBatch();
        const target = Math.max(0, session.batchSize | 0);
        const remaining = Math.max(0, target - processedBefore);
        if (remaining === 0) {
          batchReachedTarget = true;
          break;
        }

        await unfollow.processBatch(remaining);
        _pullCounters();
        emitStatus();
        await persistSession();
        if (!session.running) break;
        if (_processedInBatch() >= target) {
          batchReachedTarget = true;
          break;
        }
      } else {
        // mode === 'all' (or any non-batch value): drain the queue;
        // when it goes empty, ask the scroll controller for more.
        const r = await processOneWithPause();
        _pullCounters();
        if (r) {
          emitStatus();
          await persistSession();
        }
        // 3-strike check after each unfollow attempt so a sustained
        // selector failure surfaces immediately rather than waiting
        // for the queue to drain.
        if (session.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          break;
        }
        if (!session.running) break;
        if (r === null) {
          // Queue drained. Walk the list to see if more accounts exist.
          const wait = await scrollController.waitForNewAccounts();
          _pullCounters();
          if (wait.exhausted) {
            // One final discover pass at the bottom for any straggler
            // cells that landed without a discovery event.
            discovery.discoverVisible();
            _pullCounters();
            break;
          }
          // New cells should now be in the DOM; loop around to discover.
          emitStatus();
          await persistSession();
        }
      }
    }
  } catch (err) {
    session.lastError = err && err.message ? err.message : String(err);
    session.running = false;
    emitError(session.lastError);
    emitStatus();
    return;
  } finally {
    session.elapsedMs = Date.now() - startedAt;
    _pullCounters();
    await persistSession();
  }

  // 3-strike stop rule. Surfaced regardless of how the loop exited so a
  // selector failure is loud rather than silent.
  if (session.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
    session.running = false;
    session.paused = false;
    const reason = 'X UI may have changed — selector failure threshold reached';
    session.lastError = reason;
    emitError(reason);
    emitStatus();
    await persistSession();
    return;
  }

  // Normal exit. Mark running=false, emit the closing events.
  session.running = false;
  session.paused = false;
  _pullCounters();
  emitStatus();
  emitCompleted(batchReachedTarget ? 'batch_target_reached' : 'finished');
  await persistSession();
}

// ---------- Inbound message handlers ----------

function handleStart() {
  if (session.running) return;
  if (!XAdapter.isFollowingPage()) {
    session.lastError = 'Not on a Following page';
    emitError(session.lastError);
    emitStatus();
    return;
  }
  session.running = true;
  session.paused = false;
  session.consecutiveFailures = 0;
  session.lastError = null;
  session.elapsedMs = 0;
  // Reset the safety governor so a prior run's tripped breaker
  // (e.g. from a previous session) does not poison this one.
  try { safetyGovernor.reset(); } catch (_) { /* ignore */ }
  try { rateController.adaptiveReset(); } catch (_) { /* ignore */ }
  _pullCounters();
  emitStatus();
  persistSession();

  // Kick off the loop. We do not await it here; the message handler
  // must return promptly. The loop self-terminates and emits COMPLETED.
  if (_loopPromise) {
    // Defensive: if a prior loop is somehow still around, do not
    // double-start.
    return;
  }
  _loopPromise = (async () => {
    try {
      await runLoop();
    } finally {
      _loopPromise = null;
    }
  })();
}

function handlePause() {
  if (!session.running) return;
  session.paused = true;
  emitStatus();
  persistSession();
}

function handleResume() {
  if (!session.running) return;
  if (!session.paused) {
    emitStatus();
    return;
  }
  session.paused = false;
  _resumePauseWaiter();
  emitStatus();
  persistSession();
}

function handleStop() {
  if (!session.running) return;
  session.running = false;
  session.paused = false;
  _rejectPauseWaiter();
  // Let the loop finish its current iteration naturally; it will
  // observe running=false and exit on its own.
  _pullCounters();
  emitStatus();
  emitCompleted('stopped');
  persistSession();
}

function handleGetStatus() {
  _pullCounters();
  emitStatus();
}

function handleSetSpeed(payload) {
  if (!payload || typeof payload !== 'object') return;
  const { preset, customMs } = payload;
  if (typeof preset === 'string') {
    if (preset === 'custom') {
      const ms = Number.isFinite(customMs) ? customMs : (session.customDelayMs || 1000);
      rateController.setCustomDelay(ms);
      rateController.setPreset('custom');
      session.speed = 'custom';
      session.customDelayMs = ms;
    } else {
      rateController.setPreset(preset);
      session.speed = preset;
    }
  } else if (Number.isFinite(customMs)) {
    rateController.setCustomDelay(customMs);
    session.customDelayMs = customMs;
  }
  emitStatus();
  persistSession();
}

function handleSetMode(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (typeof payload.mode === 'string') {
    session.mode = payload.mode;
  }
  if (Number.isFinite(payload.batchSize) && payload.batchSize > 0) {
    session.batchSize = Math.trunc(payload.batchSize);
  }
  emitStatus();
  persistSession();
}

function handleSetBatchSize(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (!Number.isFinite(payload.batchSize) || payload.batchSize <= 0) return;
  session.batchSize = Math.trunc(payload.batchSize);
  emitStatus();
  persistSession();
}
function handleSetFilterConfig(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (typeof payload.filterMode === 'string') session.filterMode = payload.filterMode;
  if (typeof payload.protectMutuals === 'boolean') session.protectMutuals = payload.protectMutuals;
  if (typeof payload.protectVerified === 'boolean') session.protectVerified = payload.protectVerified;
  if (typeof payload.skipDefaultAvatars === 'boolean') session.skipDefaultAvatars = payload.skipDefaultAvatars;
  if (Array.isArray(payload.bioKeywordsExclude)) session.bioKeywordsExclude = payload.bioKeywordsExclude;
  emitStatus();
  persistSession();
}

function handleSetWhitelist(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload.whitelist)) {
    session.whitelist = payload.whitelist;
    whitelist.clear();
    for (const h of payload.whitelist) whitelist.add(h);
  }
  emitStatus();
  persistSession();
}

const INBOUND_HANDLERS = Object.freeze({
  START: handleStart,
  PAUSE: handlePause,
  RESUME: handleResume,
  STOP: handleStop,
  GET_STATUS: handleGetStatus,
  SET_SPEED: handleSetSpeed,
  SET_MODE: handleSetMode,
  SET_BATCH_SIZE: handleSetBatchSize,
});

const EXTENDED_HANDLERS = Object.freeze({
  SET_FILTER_CONFIG: handleSetFilterConfig,
  SET_WHITELIST: handleSetWhitelist,
});

function dispatchMessage(message, _sender, _sendResponse) {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    if (typeof _sendResponse === 'function') _sendResponse({ ok: false, error: 'invalid_message' });
    return false;
  }
  if (message.type === 'PING') {
    if (typeof _sendResponse === 'function') {
      _sendResponse({
        ok: true,
        isFollowingPage: XAdapter.isFollowingPage(),
        session: _snapshotSession(),
      });
    }
    return false;
  }
  const handler = INBOUND_HANDLERS[message.type] || EXTENDED_HANDLERS[message.type];
  if (typeof handler !== 'function') {
    if (typeof _sendResponse === 'function') _sendResponse({ ok: false, error: 'no_handler' });
    return false;
  }
  try {
    const res = handler(message.payload);
    if (typeof _sendResponse === 'function') {
      _sendResponse({ ok: true, result: res, session: _snapshotSession() });
    }
  } catch (err) {
    session.lastError = err && err.message ? err.message : String(err);
    emitError(session.lastError);
    emitStatus();
    if (typeof _sendResponse === 'function') {
      _sendResponse({ ok: false, error: session.lastError });
    }
  }
  return false;
}

// ---------- Public testing surface ----------
//
// Expose a small surface so unit tests can drive the orchestrator
// without going through chrome.runtime. The Chrome path uses
// `dispatchMessage` directly via the onMessage listener below.

export const __test__ = {
  session,
  queue,
  rateController,
  scrollController,
  discovery,
  unfollow,
  runLoop,
  processOneWithPause,
  handleStart,
  handlePause,
  handleResume,
  handleStop,
  handleGetStatus,
  handleSetSpeed,
  handleSetMode,
  handleSetBatchSize,
  dispatchMessage,
  persistSession,
  loadPersistedSession,
  sendOutbound,
  emitStatus,
  emitEvent,
  emitError,
  emitCompleted,
};

// ---------- Wire-up ----------
//
// Only attach chrome.runtime listeners when this module actually runs
// in a browser content-script context. In Node (test harness, JSDOM)
// the `document` global is absent; the guards below ensure the file
// remains import-safe.

if (typeof document !== 'undefined') {
  // Best-effort restore of counters from a prior session. The user
  // must press START to resume; we never auto-resume.
  loadPersistedSession();

  const api = _chromeRuntime();
  if (api && api.runtime && api.runtime.onMessage
      && typeof api.runtime.onMessage.addListener === 'function') {
    try {
      api.runtime.onMessage.addListener(dispatchMessage);
    } catch (_) {
      // Adding a listener can fail if the API surface is partial. The
      // engine still works for direct (test) invocations of __test__.
    }
  }

  // Surface a STATUS right after attach so the popup can show accurate
  // numbers even before the user presses START.
  try { emitStatus(); } catch (_) { /* ignore */ }
}
