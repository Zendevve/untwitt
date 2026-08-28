// untwitt popup script — classic script (no type=module) for MV3 popup compat.
// Talks to the service worker and content script via chrome.runtime.sendMessage.

(function () {
  "use strict";

  // --- Chrome guard ----------------------------------------------------------
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    statePill:        $("state-pill"),
    unfollowedBig:    $("unfollowed-big"),
    detected:         $("detected"),
    filterDisp:       $("filter-disp"),
    speedDisp:        $("speed-disp"),
    elapsed:          $("elapsed"),

    cDetected:        $("c-detected"),
    cQueued:          $("c-queued"),
    cUnfollowed:      $("c-unfollowed"),
    cFailed:          $("c-failed"),
    cSkipped:         $("c-skipped"),
    progressBar:      $("progress-bar"),

    primaryBtn:       $("primary-btn"),
    stopBtn:          $("stop-btn"),
    pauseBtn:         $("pause-btn"),
    resumeBtn:        $("resume-btn"),
    resetBtn:         $("reset-btn"),

    filterSel:        $("filter-sel"),
    modeSel:          $("mode-sel"),
    batchSizeSel:     $("batch-size-sel"),
    speedSel:         $("speed-sel"),
    customDelay:      $("custom-delay"),

    wlInput:          $("wl-input"),
    wlAddBtn:         $("wl-add-btn"),
    wlList:           $("wl-list"),
    wlExportBtn:      $("wl-export-btn"),
    wlClearBtn:       $("wl-clear-btn"),

    chkProtectMutuals: $("chk-protect-mutuals"),
    chkProtectVerified:$("chk-protect-verified"),
    chkJitter:         $("chk-jitter"),
    chkSkipAvatars:    $("chk-skip-default-avatars"),
    exportAuditBtn:    $("export-audit-btn"),

    connDot:          $("conn-dot"),
    connText:         $("conn-text"),
  };

  // --- Local state cache -----------------------------------------------------
  var session = {
    state: "IDLE",
    mode: "all",
    filterMode: "non_followers",
    speedPreset: "normal",
    customMs: 1500,
    batchSize: 50,
    detected: 0,
    queued: 0,
    unfollowed: 0,
    failed: 0,
    skipped: 0,
    whitelist: [],
    protectMutuals: false,
    protectVerified: false,
    jitter: true,
    skipDefaultAvatars: false,
    updatedAt: 0,
  };

  var lastModeSent = session.mode;
  var lastBatchSent = session.batchSize;
  var lastSpeedSent = session.speedPreset;
  var lastCustomSent = session.customMs;
  var lastFilterSent = session.filterMode;

  function safeSend(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        var err = chrome.runtime.lastError;
        if (typeof cb === "function") cb(err, resp);
      });
    } catch (e) {
      if (typeof cb === "function") cb(e, null);
    }
  }

  function fmtElapsed(ms) {
    var s = Math.floor(Math.max(0, ms || 0) / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    var mm = (m < 10 ? "0" : "") + m;
    var ss = (s < 10 ? "0" : "") + s;
    return mm + ":" + ss;
  }

  function speedLabel(preset) {
    switch (preset) {
      case "fast":     return "Fast";
      case "normal":   return "Normal";
      case "moderate": return "Moderate";
      case "slow":     return "Slow";
      case "stealth":  return "Stealth";
      case "custom":   return "Custom";
      default:         return "Normal";
    }
  }

  function filterLabel(filter) {
    switch (filter) {
      case "non_followers": return "Non-followers";
      case "mutuals_only":  return "Mutuals";
      case "all":           return "All";
      default:              return "Non-followers";
    }
  }

  function setProgress(pct) {
    var p = Math.max(0, Math.min(100, pct || 0));
    if (els.progressBar) els.progressBar.style.width = p + "%";
  }

  // --- Render ----------------------------------------------------------------
  function render() {
    var st = (session.state || "IDLE").toLowerCase();
    if (els.statePill) {
      els.statePill.textContent = (session.state || "IDLE").toUpperCase();
      els.statePill.className = "state " + st;
    }

    if (els.unfollowedBig) els.unfollowedBig.textContent = String(session.unfollowed | 0);
    if (els.detected) els.detected.textContent  = String(session.detected | 0);
    if (els.filterDisp) els.filterDisp.textContent = filterLabel(session.filterMode);
    if (els.speedDisp) els.speedDisp.textContent = speedLabel(session.speedPreset);

    if (els.cDetected)   els.cDetected.textContent   = String(session.detected | 0);
    if (els.cQueued)     els.cQueued.textContent     = String(session.queued | 0);
    if (els.cUnfollowed) els.cUnfollowed.textContent = String(session.unfollowed | 0);
    if (els.cFailed)     els.cFailed.textContent     = String(session.failed | 0);
    if (els.cSkipped)    els.cSkipped.textContent    = String(session.skipped | 0);

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
    } else if (st === "paused") {
      els.primaryBtn.textContent = "RESUME";
      els.primaryBtn.disabled = false;
      els.stopBtn.disabled = false;
    } else if (st === "done") {
      els.primaryBtn.textContent = "DONE";
      els.primaryBtn.disabled = true;
      els.stopBtn.disabled = true;
    } else {
      // IDLE / STOPPED / ERROR
      if (session.filterMode === "non_followers") {
        els.primaryBtn.textContent = "UNFOLLOW NON-FOLLOWERS";
      } else if (session.filterMode === "mutuals_only") {
        els.primaryBtn.textContent = "UNFOLLOW MUTUALS";
      } else {
        els.primaryBtn.textContent = "UNFOLLOW ALL";
      }
      els.primaryBtn.disabled = false;
      els.stopBtn.disabled = true;
    }

    if (els.filterSel && els.filterSel.value !== session.filterMode) {
      els.filterSel.value = session.filterMode;
    }

    if (els.modeSel && els.modeSel.value !== session.mode) {
      els.modeSel.value = session.mode;
    }
    if (session.mode === "batch") {
      if (els.batchSizeSel) els.batchSizeSel.classList.remove("hidden");
      var want = String(session.batchSize);
      if (els.batchSizeSel && els.batchSizeSel.value !== want) els.batchSizeSel.value = want;
    } else {
      if (els.batchSizeSel) els.batchSizeSel.classList.add("hidden");
    }

    if (els.speedSel && els.speedSel.value !== session.speedPreset) {
      els.speedSel.value = session.speedPreset;
    }
    if (session.speedPreset === "custom") {
      if (els.customDelay) {
        els.customDelay.classList.remove("hidden");
        if (document.activeElement !== els.customDelay) {
          els.customDelay.value = String(session.customMs | 0);
        }
      }
    } else {
      if (els.customDelay) els.customDelay.classList.add("hidden");
    }

    renderWhitelist();
  }

  function renderWhitelist() {
    if (!els.wlList) return;
    els.wlList.innerHTML = "";
    var list = Array.isArray(session.whitelist) ? session.whitelist : [];
    if (list.length === 0) {
      var emptyLi = document.createElement("li");
      emptyLi.className = "wl-item";
      emptyLi.style.color = "var(--fg-dim)";
      emptyLi.textContent = "No accounts protected.";
      els.wlList.appendChild(emptyLi);
      return;
    }

    list.forEach(function (h) {
      var li = document.createElement("li");
      li.className = "wl-item";

      var span = document.createElement("span");
      span.textContent = h;

      var del = document.createElement("button");
      del.type = "button";
      del.className = "wl-del-btn";
      del.textContent = "✕";
      del.title = "Remove from whitelist";
      del.addEventListener("click", function () {
        removeWhitelistHandle(h);
      });

      li.appendChild(span);
      li.appendChild(del);
      els.wlList.appendChild(li);
    });
  }

  function addWhitelistHandle(handle) {
    if (!handle) return;
    var s = handle.trim().toLowerCase();
    if (!s) return;
    if (!s.startsWith("@")) s = "@" + s;
    if (!Array.isArray(session.whitelist)) session.whitelist = [];
    if (session.whitelist.indexOf(s) === -1) {
      session.whitelist.push(s);
      session.whitelist.sort();
      safeSend({ type: "SET_WHITELIST", payload: { whitelist: session.whitelist } });
      renderWhitelist();
    }
    if (els.wlInput) els.wlInput.value = "";
  }

  function removeWhitelistHandle(handle) {
    if (!Array.isArray(session.whitelist)) return;
    var idx = session.whitelist.indexOf(handle);
    if (idx !== -1) {
      session.whitelist.splice(idx, 1);
      safeSend({ type: "SET_WHITELIST", payload: { whitelist: session.whitelist } });
      renderWhitelist();
    }
  }

  // --- Elapsed ticker --------------------------------------------------------
  function tickElapsed() {
    var base = session.updatedAt || 0;
    if (session.state === "RUNNING" || session.state === "PAUSED") {
      var now = Date.now();
      var elapsed = (session.state === "PAUSED" ? 0 : (now - base));
      if (els.elapsed) els.elapsed.textContent = fmtElapsed(elapsed);
    } else {
      if (els.elapsed) els.elapsed.textContent = "00:00";
    }
  }
  setInterval(tickElapsed, 1000);

  // --- Connection probe ------------------------------------------------------
  function probeConn() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var t = tabs && tabs[0];
        if (!t) {
          if (els.connDot) els.connDot.className = "dot";
          if (els.connText) els.connText.textContent = "no active tab";
          return;
        }
        if (chrome.tabs.sendMessage) {
          try {
            chrome.tabs.sendMessage(t.id, { type: "PING" }, function (resp) {
              if (chrome.runtime.lastError || !resp) {
                if (els.connDot) els.connDot.className = "dot error";
                if (els.connText) els.connText.textContent = "tab not ready";
              } else {
                if (els.connDot) els.connDot.className = "dot connected";
                if (els.connText) els.connText.textContent = "connected";
              }
            });
          } catch (e) {
            if (els.connDot) els.connDot.className = "dot error";
            if (els.connText) els.connText.textContent = "tab not ready";
          }
        }
      });
    } catch (e) {
      if (els.connDot) els.connDot.className = "dot";
      if (els.connText) els.connText.textContent = "no active tab";
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
      lastFilterSent = session.filterMode;
      render();
    });
  }

  // --- Tab Switching ---------------------------------------------------------
  var tabButtons = document.querySelectorAll(".tab-btn");
  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var tabId = btn.getAttribute("data-tab");
      tabButtons.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");

      document.querySelectorAll(".tab-content").forEach(function (content) {
        content.classList.add("hidden");
      });
      var activeTab = $("tab-" + tabId);
      if (activeTab) activeTab.classList.remove("hidden");
    });
  });

  // --- Controls wiring -------------------------------------------------------
  if (els.primaryBtn) {
    els.primaryBtn.addEventListener("click", function () {
      var st = (session.state || "IDLE").toUpperCase();
      if (st === "IDLE" || st === "DONE" || st === "STOPPED" || st === "ERROR") {
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
  }

  if (els.stopBtn) {
    els.stopBtn.addEventListener("click", function () {
      safeSend({ type: "STOP" });
    });
  }

  if (els.resetBtn) {
    els.resetBtn.addEventListener("click", function () {
      safeSend({ type: "RESET_SESSION" }, function () {
        loadSession();
      });
    });
  }

  if (els.filterSel) {
    els.filterSel.addEventListener("change", function () {
      var f = els.filterSel.value;
      session.filterMode = f;
      lastFilterSent = f;
      render();
    });
  }

  if (els.modeSel) {
    els.modeSel.addEventListener("change", function () {
      var m = els.modeSel.value;
      session.mode = m;
      if (m === "batch") {
        if (els.batchSizeSel) els.batchSizeSel.classList.remove("hidden");
        var bs = parseInt(els.batchSizeSel ? els.batchSizeSel.value : "50", 10) || 50;
        session.batchSize = bs;
        lastBatchSent = bs;
      } else {
        if (els.batchSizeSel) els.batchSizeSel.classList.add("hidden");
      }
      lastModeSent = m;
      safeSend({ type: "SET_MODE", payload: { mode: m, batchSize: session.batchSize } });
      render();
    });
  }

  if (els.batchSizeSel) {
    els.batchSizeSel.addEventListener("change", function () {
      var bs = parseInt(els.batchSizeSel.value, 10) || 50;
      session.batchSize = bs;
      lastBatchSent = bs;
      safeSend({ type: "SET_BATCH_SIZE", payload: { batchSize: bs } });
      render();
    });
  }

  if (els.speedSel) {
    els.speedSel.addEventListener("change", function () {
      var sp = els.speedSel.value;
      session.speedPreset = sp;
      if (sp === "custom") {
        if (els.customDelay) els.customDelay.classList.remove("hidden");
        var cm = parseInt(els.customDelay ? els.customDelay.value : "1500", 10);
        if (!isNaN(cm)) session.customMs = cm;
      } else {
        if (els.customDelay) els.customDelay.classList.add("hidden");
      }
      lastSpeedSent = sp;
      var payload = { preset: sp };
      if (sp === "custom") payload.customMs = session.customMs;
      safeSend({ type: "SET_SPEED", payload: payload });
      render();
    });
  }

  if (els.wlAddBtn && els.wlInput) {
    els.wlAddBtn.addEventListener("click", function () {
      addWhitelistHandle(els.wlInput.value);
    });
    els.wlInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") addWhitelistHandle(els.wlInput.value);
    });
  }

  if (els.wlClearBtn) {
    els.wlClearBtn.addEventListener("click", function () {
      session.whitelist = [];
      safeSend({ type: "SET_WHITELIST", payload: { whitelist: [] } });
      renderWhitelist();
    });
  }

  if (els.wlExportBtn) {
    els.wlExportBtn.addEventListener("click", function () {
      var text = "handle\n" + (session.whitelist || []).join("\n");
      var blob = new Blob([text], { type: "text/csv" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "untwitt-whitelist.csv";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // --- Inbound STATUS messages from service worker --------------------------
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "STATUS" && msg.session) {
        session = Object.assign({}, session, msg.session);
        render();
      } else if (msg.type === "STATUS" && msg.counters) {
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
