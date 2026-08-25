// untwitt popup script — classic script (no type=module) for MV3 popup compat.
// Talks to the service worker exclusively via chrome.runtime.sendMessage.

(function () {
  "use strict";

  // --- Chrome guard ----------------------------------------------------------
  // If chrome is undefined (e.g. running under a Node test harness), bail to a
  // stub render so the file can be loaded without throwing.
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    document.addEventListener("DOMContentLoaded", function () {
      var pill = document.getElementById("state-pill");
      if (pill) {
        pill.textContent = "IDLE";
        pill.className = "state idle";
      }
    });
    return;
  }

  // --- DOM lookup ------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    statePill:    $("state-pill"),
    unfollowedBig: $("unfollowed-big"),
    detected:     $("detected"),
    modeDisp:     $("mode-disp"),
    speedDisp:    $("speed-disp"),
    elapsed:      $("elapsed"),
    cDetected:    $("c-detected"),
    cQueued:      $("c-queued"),
    cUnfollowed:  $("c-unfollowed"),
    cFailed:      $("c-failed"),
    cSkipped:     $("c-skipped"),
    progressBar:  $("progress-bar"),
    primaryBtn:   $("primary-btn"),
    stopBtn:      $("stop-btn"),
    pauseBtn:     $("pause-btn"),
    resumeBtn:    $("resume-btn"),
    resetBtn:     $("reset-btn"),
    modeSel:      $("mode-sel"),
    batchSizeSel: $("batch-size-sel"),
    speedSel:     $("speed-sel"),
    customDelay:  $("custom-delay"),
    connDot:      $("conn-dot"),
    connText:     $("conn-text")
  };

  // --- Local state cache -----------------------------------------------------
  var session = {
    state: "IDLE",
    detected: 0,
    queued: 0,
    unfollowed: 0,
    failed: 0,
    skipped: 0,
    mode: "all",
    batchSize: 50,
    speedPreset: "normal",
    customMs: 1500,
    updatedAt: 0
  };

  var lastModeSent = session.mode;
  var lastBatchSent = session.batchSize;
  var lastSpeedSent = session.speedPreset;
  var lastCustomSent = session.customMs;

  // --- Helpers ---------------------------------------------------------------
  function safeSend(msg, cb) {
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (cb && typeof p && typeof p.then === "function") {
        p.then(function (r) { cb(null, r); }, function (e) { cb(e); });
      } else if (cb) {
        cb(null, null);
      }
    } catch (e) {
      if (cb) cb(e);
    }
  }

  function fmtElapsed(ms) {
    if (!ms || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function speedLabel(preset) {
    switch (preset) {
      case "fast":    return "Fast";
      case "normal":  return "Normal";
      case "moderate": return "Moderate";
      case "slow":    return "Slow";
      case "custom":  return "Custom";
      default:        return "Normal";
    }
  }

  function modeLabel(mode, batch) {
    if (mode === "batch") return "Batch (" + batch + ")";
    return "All";
  }

  function setProgress(pct) {
    var p = Math.max(0, Math.min(100, pct || 0));
    els.progressBar.style.width = p + "%";
  }

  // --- Render ----------------------------------------------------------------
  function render() {
    var st = (session.state || "IDLE").toLowerCase();
    els.statePill.textContent = (session.state || "IDLE").toUpperCase();
    els.statePill.className = "state " + st;

    els.unfollowedBig.textContent = String(session.unfollowed | 0);
    els.detected.textContent  = String(session.detected | 0);
    els.modeDisp.textContent  = modeLabel(session.mode, session.batchSize);
    els.speedDisp.textContent = speedLabel(session.speedPreset);

    els.cDetected.textContent   = String(session.detected | 0);
    els.cQueued.textContent     = String(session.queued | 0);
    els.cUnfollowed.textContent = String(session.unfollowed | 0);
    els.cFailed.textContent     = String(session.failed | 0);
    els.cSkipped.textContent    = String(session.skipped | 0);

    var denom = (session.detected | 0) + (session.queued | 0) + (session.unfollowed | 0);
    if (denom > 0) {
      setProgress((session.unfollowed | 0) / denom * 100);
    } else {
      setProgress(0);
    }

    // Primary button label + state
    if (st === "running") {
      els.primaryBtn.textContent = "PAUSE";
      els.primaryBtn.disabled = false;
      els.stopBtn.disabled = false;
      els.pauseBtn.classList.add("hidden");
      els.resumeBtn.classList.add("hidden");
    } else if (st === "paused") {
      els.primaryBtn.textContent = "RESUME";
      els.primaryBtn.disabled = false;
      els.stopBtn.disabled = false;
      els.pauseBtn.classList.add("hidden");
      els.resumeBtn.classList.add("hidden");
    } else if (st === "done") {
      els.primaryBtn.textContent = "DONE";
      els.primaryBtn.disabled = true;
      els.stopBtn.disabled = true;
      els.pauseBtn.classList.add("hidden");
      els.resumeBtn.classList.add("hidden");
    } else {
      // IDLE / STOPPED / ERROR
      els.primaryBtn.textContent = "UNFOLLOW ALL";
      els.primaryBtn.disabled = false;
      els.stopBtn.disabled = true;
      els.pauseBtn.classList.add("hidden");
      els.resumeBtn.classList.add("hidden");
    }

    // Selects reflect session
    if (els.modeSel.value !== session.mode) {
      els.modeSel.value = session.mode;
    }
    if (session.mode === "batch") {
      els.batchSizeSel.classList.remove("hidden");
      var want = String(session.batchSize);
      if (els.batchSizeSel.value !== want) els.batchSizeSel.value = want;
    } else {
      els.batchSizeSel.classList.add("hidden");
    }

    if (els.speedSel.value !== session.speedPreset) {
      els.speedSel.value = session.speedPreset;
    }
    if (session.speedPreset === "custom") {
      els.customDelay.classList.remove("hidden");
      if (document.activeElement !== els.customDelay) {
        els.customDelay.value = String(session.customMs | 0);
      }
    } else {
      els.customDelay.classList.add("hidden");
    }
  }

  // --- Elapsed ticker --------------------------------------------------------
  function tickElapsed() {
    var base = session.updatedAt || 0;
    if (session.state === "RUNNING" || session.state === "PAUSED") {
      var now = Date.now();
      var elapsed = (session.state === "PAUSED" ? 0 : (now - base));
      els.elapsed.textContent = fmtElapsed(elapsed);
    } else {
      els.elapsed.textContent = "00:00";
    }
  }
  setInterval(tickElapsed, 1000);

  // --- Connection probe ------------------------------------------------------
  function probeConn() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var t = tabs && tabs[0];
        if (!t) {
          els.connDot.className = "dot";
          els.connText.textContent = "no active tab";
          return;
        }
        if (chrome.tabs.sendMessage) {
          try {
            chrome.tabs.sendMessage(t.id, { type: "PING" }, function (resp) {
              if (chrome.runtime.lastError || !resp) {
                els.connDot.className = "dot error";
                els.connText.textContent = "tab not ready";
              } else {
                els.connDot.className = "dot connected";
                els.connText.textContent = "connected";
              }
            });
          } catch (e) {
            els.connDot.className = "dot error";
            els.connText.textContent = "tab not ready";
          }
        } else {
          els.connDot.className = "dot";
          els.connText.textContent = "no active tab";
        }
      });
    } catch (e) {
      els.connDot.className = "dot";
      els.connText.textContent = "no active tab";
    }
  }

  // --- Session IO ------------------------------------------------------------
  function loadSession() {
    safeSend({ type: "GET_SESSION" }, function (err, resp) {
      if (err || !resp) return;
      session = Object.assign({}, session, resp);
      lastModeSent = session.mode;
      lastBatchSent = session.batchSize;
      lastSpeedSent = session.speedPreset;
      lastCustomSent = session.customMs;
      render();
    });
  }

  // --- Button wiring ---------------------------------------------------------
  els.primaryBtn.addEventListener("click", function () {
    var st = (session.state || "IDLE").toUpperCase();
    if (st === "IDLE" || st === "DONE" || st === "STOPPED" || st === "ERROR") {
      // push any pending mode/batch/speed changes first
      if (session.mode !== lastModeSent) {
        safeSend({ type: "SET_MODE", payload: { mode: session.mode, batchSize: session.batchSize } });
        lastModeSent = session.mode;
      } else if (session.batchSize !== lastBatchSent) {
        safeSend({ type: "SET_BATCH_SIZE", payload: { batchSize: session.batchSize } });
        lastBatchSent = session.batchSize;
      }
      if (session.speedPreset !== lastSpeedSent ||
          (session.speedPreset === "custom" && session.customMs !== lastCustomSent)) {
        var payload = { preset: session.speedPreset };
        if (session.speedPreset === "custom") payload.customMs = session.customMs;
        safeSend({ type: "SET_SPEED", payload: payload });
        lastSpeedSent = session.speedPreset;
        lastCustomSent = session.customMs;
      }
      safeSend({ type: "START" });
    } else if (st === "RUNNING") {
      safeSend({ type: "PAUSE" });
    } else if (st === "PAUSED") {
      safeSend({ type: "RESUME" });
    }
  });

  els.stopBtn.addEventListener("click", function () {
    safeSend({ type: "STOP" });
  });

  els.resetBtn.addEventListener("click", function () {
    safeSend({ type: "RESET_SESSION" }, function () {
      loadSession();
    });
  });

  els.modeSel.addEventListener("change", function () {
    var m = els.modeSel.value;
    session.mode = m;
    if (m === "batch") {
      els.batchSizeSel.classList.remove("hidden");
      var bs = parseInt(els.batchSizeSel.value, 10) || 50;
      session.batchSize = bs;
      lastBatchSent = bs;
    } else {
      els.batchSizeSel.classList.add("hidden");
    }
    lastModeSent = m;
    safeSend({ type: "SET_MODE", payload: { mode: m, batchSize: session.batchSize } });
    render();
  });

  els.batchSizeSel.addEventListener("change", function () {
    var bs = parseInt(els.batchSizeSel.value, 10) || 50;
    session.batchSize = bs;
    lastBatchSent = bs;
    safeSend({ type: "SET_BATCH_SIZE", payload: { batchSize: bs } });
    render();
  });

  els.speedSel.addEventListener("change", function () {
    var sp = els.speedSel.value;
    session.speedPreset = sp;
    if (sp === "custom") {
      els.customDelay.classList.remove("hidden");
      var cm = parseInt(els.customDelay.value, 10);
      if (!isNaN(cm)) session.customMs = cm;
    } else {
      els.customDelay.classList.add("hidden");
    }
    lastSpeedSent = sp;
    var payload = { preset: sp };
    if (sp === "custom") payload.customMs = session.customMs;
    safeSend({ type: "SET_SPEED", payload: payload });
    render();
  });

  els.customDelay.addEventListener("change", function () {
    var cm = parseInt(els.customDelay.value, 10);
    if (isNaN(cm) || cm < 100) cm = 100;
    if (cm > 60000) cm = 60000;
    session.customMs = cm;
    lastCustomSent = cm;
    safeSend({ type: "SET_SPEED", payload: { preset: "custom", customMs: cm } });
    render();
  });

  // --- Inbound STATUS messages from service worker --------------------------
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "STATUS" && msg.session) {
        session = Object.assign({}, session, msg.session);
        render();
      } else if (msg.type === "STATUS" && msg.counters) {
        // tolerate flat shape too
        if (typeof msg.counters.detected   === "number") session.detected   = msg.counters.detected;
        if (typeof msg.counters.queued     === "number") session.queued     = msg.counters.queued;
        if (typeof msg.counters.unfollowed === "number") session.unfollowed = msg.counters.unfollowed;
        if (typeof msg.counters.failed     === "number") session.failed     = msg.counters.failed;
        if (typeof msg.counters.skipped    === "number") session.skipped    = msg.counters.skipped;
        if (msg.counters.state)   session.state     = msg.counters.state;
        if (msg.counters.updatedAt) session.updatedAt = msg.counters.updatedAt;
        render();
      }
    });
  }

  // --- Boot ------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    render();
    loadSession();
    probeConn();
  });
})();
