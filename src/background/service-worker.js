// untwitt MV3 service worker.
// Classic script (no ES module imports) — registered via manifest.background.scripts.
// Holds session state in chrome.storage.session and routes messages between
// the popup and the active tab's content script.

(function (global) {
  "use strict";

  if (typeof global === "undefined" || !global.chrome || !global.chrome.runtime) {
    return;
  }

  var chromeRef = global.chrome;
  var SESSION_KEY = "untwitt.session.v1";

  function defaultSession() {
    return {
      running: false,
      paused: false,
      mode: "all",
      filterMode: "non_followers",
      speed: "normal",
      batchSize: 50,
      customDelayMs: null,
      discoveredCount: 0,
      queuedCount: 0,
      unfollowedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      whitelist: [],
      protectMutuals: false,
      protectVerified: false,
      jitter: true,
      skipDefaultAvatars: false,
      elapsedMs: 0,
      lastError: null,
      updatedAt: 0
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readSession() {
    return new Promise(function (resolve) {
      chromeRef.storage.session.get(SESSION_KEY, function (data) {
        var session = data && data[SESSION_KEY] ? data[SESSION_KEY] : defaultSession();
        resolve(session);
      });
    });
  }

  function writeSession(session) {
    return new Promise(function (resolve) {
      var record = {};
      record[SESSION_KEY] = session;
      chromeRef.storage.session.set(record, function () {
        resolve(session);
      });
    });
  }

  function getActiveTab() {
    return new Promise(function (resolve) {
      chromeRef.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function sendToContent(tab, message) {
    if (!tab || !tab.id) {
      return Promise.resolve({ ok: false, error: "no_active_tab" });
    }
    return new Promise(function (resolve) {
      chromeRef.tabs.sendMessage(tab.id, message, function (response) {
        if (chromeRef.runtime.lastError) {
          resolve({ ok: false, error: chromeRef.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: true });
      });
    });
  }

  function broadcastToPopup(message) {
    try {
      chromeRef.runtime.sendMessage(message, function () {
        if (chromeRef.runtime.lastError) {
          // Popup not open; ignore silently.
        }
      });
    } catch (_) {
      // Ignored
    }
  }

  function handleGetSession(sendResponse) {
    readSession().then(function (session) {
      sendResponse({ ok: true, session: session });
    });
  }

  function handleResetSession(sendResponse) {
    var fresh = defaultSession();
    writeSession(fresh).then(function (session) {
      broadcastToPopup({ target: "popup", type: "SESSION_RESET", session: session });
      sendResponse({ ok: true, session: session });
    });
  }

  function handlePatchSession(patch, sendResponse) {
    readSession().then(function (current) {
      var merged = clone(current);
      if (patch && typeof patch === "object") {
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) {
            merged[k] = patch[k];
          }
        }
      }
      merged.updatedAt = Date.now();
      return writeSession(merged).then(function (session) {
        sendResponse({ ok: true, session: session });
      });
    });
  }

  function handleForwardToContent(message, sendResponse) {
    getActiveTab().then(function (tab) {
      return sendToContent(tab, message);
    }).then(function (result) {
      sendResponse(result);
    });
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg !== "object") {
      sendResponse({ ok: false, error: "invalid_message" });
      return false;
    }

    if (msg.target === "content-script") {
      // Forward directly to the active tab's content script.
      getActiveTab().then(function (tab) {
        return sendToContent(tab, msg.message || msg);
      }).then(function (result) {
        sendResponse(result);
      });
      return true;
    }

    if (msg.target === "service-worker") {
      switch (msg.type) {
        case "GET_SESSION":
          handleGetSession(sendResponse);
          return true;
        case "RESET_SESSION":
          handleResetSession(sendResponse);
          return true;
        case "PATCH_SESSION":
          handlePatchSession(msg.patch, sendResponse);
          return true;
        case "FORWARD_TO_CONTENT":
          handleForwardToContent(msg.message, sendResponse);
          return true;
        default:
          sendResponse({ ok: false, error: "unknown_type" });
          return false;
      }
    }

    // Direct forwarding for popup-to-content messages
    if (msg.type === "START" || msg.type === "PAUSE" || msg.type === "RESUME" ||
        msg.type === "STOP" || msg.type === "SET_MODE" || msg.type === "SET_SPEED" ||
        msg.type === "SET_BATCH_SIZE" || msg.type === "SET_WHITELIST") {
      getActiveTab().then(function (tab) {
        return sendToContent(tab, msg);
      }).then(function (result) {
        sendResponse(result);
      });
      return true;
    }

    // Backwards-compatible fallback: if sender is the content script and the
    // message looks like a status/counter event, mirror it into session state
    // and broadcast to the popup.
    if (sender && sender.tab) {
      mirrorStatusEvent(msg).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    }

    sendResponse({ ok: false, error: "no_handler" });
    return false;
  }

  // Map a content-script status event onto session fields.
  function statusToPatch(msg) {
    if (!msg || typeof msg !== "object") return null;
    var patch = {};
    switch (msg.type) {
      case "STATUS":
        if (typeof msg.running === "boolean") patch.running = msg.running;
        if (typeof msg.paused === "boolean") patch.paused = msg.paused;
        if (typeof msg.mode === "string") patch.mode = msg.mode;
        if (typeof msg.filterMode === "string") patch.filterMode = msg.filterMode;
        if (typeof msg.speed === "string") patch.speed = msg.speed;
        if (typeof msg.batchSize === "number") patch.batchSize = msg.batchSize;
        if ("customDelayMs" in msg) patch.customDelayMs = msg.customDelayMs;
        if (typeof msg.elapsedMs === "number") patch.elapsedMs = msg.elapsedMs;
        if (Array.isArray(msg.whitelist)) patch.whitelist = msg.whitelist;
        if ("lastError" in msg) patch.lastError = msg.lastError;
        break;
      case "ACCOUNT_DISCOVERED":
        if (typeof msg.count === "number") patch.discoveredCount = msg.count;
        break;
      case "ACCOUNT_QUEUED":
        if (typeof msg.count === "number") patch.queuedCount = msg.count;
        break;
      case "ACCOUNT_UNFOLLOWED":
        if (typeof msg.count === "number") patch.unfollowedCount = msg.count;
        break;
      case "ACCOUNT_FAILED":
        if (typeof msg.count === "number") patch.failedCount = msg.count;
        if (msg.error) patch.lastError = msg.error;
        break;
      case "ACCOUNT_SKIPPED":
        if (typeof msg.count === "number") patch.skippedCount = msg.count;
        break;
      default:
        return null;
    }
    return patch;
  }

  function mirrorStatusEvent(msg) {
    var patch = statusToPatch(msg);
    if (!patch) {
      broadcastToPopup(msg);
      return Promise.resolve();
    }
    return readSession().then(function (current) {
      var merged = clone(current);
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) {
          merged[k] = patch[k];
        }
      }
      merged.updatedAt = Date.now();
      return writeSession(merged);
    }).then(function (session) {
      broadcastToPopup({ target: "popup", type: "SESSION_UPDATED", session: session });
      broadcastToPopup(msg);
    });
  }

  function initSession() {
    readSession().then(function (session) {
      if (!session || !session.updatedAt) {
        writeSession(defaultSession());
      }
    });
  }

  // --- Wire lifecycle ---
  chromeRef.runtime.onInstalled.addListener(function (details) {
    initSession();
  });

  chromeRef.runtime.onStartup.addListener(function () {
    initSession();
  });

  chromeRef.runtime.onMessage.addListener(onMessage);
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
