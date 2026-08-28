// untwitt popup script — classic script (no type=module) for MV3 popup compatibility.
// Talks to the background service worker and content script via chrome.runtime.sendMessage.

(function () {
  "use strict";

  // --- Chrome guard ----------------------------------------------------------
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    statePill:         $("state-pill"),
    unfollowedBig:     $("unfollowed-big"),
    detected:          $("detected"),
    filterDisp:        $("filter-disp"),
    speedDisp:         $("speed-disp"),
    elapsed:           $("elapsed"),

    cDetected:         $("c-detected"),
    cQueued:           $("c-queued"),
    cUnfollowed:       $("c-unfollowed"),
    cFailed:           $("c-failed"),
    cSkipped:          $("c-skipped"),
    progressBar:       $("progress-bar"),

    primaryBtn:        $("primary-btn"),
    stopBtn:           $("stop-btn"),
    pauseBtn:          $("pause-btn"),
    resumeBtn:         $("resume-btn"),
    resetBtn:          $("reset-btn"),

    filterSel:         $("filter-sel"),
    modeSel:           $("mode-sel"),
    batchSizeSel:      $("batch-size-sel"),
    speedSel:          $("speed-sel"),
    customDelay:       $("custom-delay"),

    wlInput:           $("wl-input"),
    wlAddBtn:          $("wl-add-btn"),
    wlList:            $("wl-list"),
    wlExportBtn:       $("wl-export-btn"),
    wlClearBtn:        $("wl-clear-btn"),

    chkProtectMutuals: $("chk-protect-mutuals"),
    chkProtectVerified:$("chk-protect-verified"),
    chkJitter:         $("chk-jitter"),
    chkSkipAvatars:    $("chk-skip-default-avatars"),
    exportAuditBtn:    $("export-audit-btn"),

    connDot:           $("conn-dot"),
    connText:          $("conn-text"),
  };

  // --- Local state cache -----------------------------------------------------
  var session = {
    state: "IDLE",
    mode: "all",
    filterMode: "non_followers",
    speedPreset: "stealth",
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
  var isCurrentTabFollowingPage = false;

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

  function sendFilterConfig() {
    safeSend({
      type: "SET_FILTER_CONFIG",
      payload: {
        filterMode: session.filterMode,
        protectMutuals: session.protectMutuals,
        protectVerified: session.protectVerified,
        jitter: session.jitter,
        skipDefaultAvatars: session.skipDefaultAvatars,
      }
    });
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
      case "stealth":  return "Gentle";
      case "custom":   return "Custom";
      default:         return "Gentle";
    }
  }

  function filterLabel(filter) {
    switch (filter) {
      case "non_followers": return "Non-followers";
      case "mutuals_only":  return "Mutuals";
      case "all":           return "All accounts";
      default:              return "Non-followers";
    }
  }

  function stateLabel(state) {
    switch (String(state || "IDLE").toUpperCase()) {
      case "RUNNING": return "Running";
      case "PAUSED":  return "Paused";
      case "DONE":    return "Completed";
      case "ERROR":   return "Error";
      case "STOPPED": return "Stopped";
      default:        return "Ready";
    }
  }

  function setProgress(pct) {
    var p = Math.max(0, Math.min(100, pct || 0));
    if (els.progressBar) {
      els.progressBar.style.width = p + "%";
    }
  }

  function render() {
    var st = (session.state || "IDLE").toLowerCase();

    if (els.statePill) {
      els.statePill.className = "state " + st;
      els.statePill.textContent = stateLabel(session.state);
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

    var processed = (session.unfollowed | 0) + (session.failed | 0) + (session.skipped | 0);
    var denom = processed + (session.queued | 0);
    if (st === "done") {
      setProgress(100);
    } else if (denom > 0) {
      setProgress((processed / denom) * 100);
    } else if ((session.detected | 0) > 0) {
      setProgress((processed / (session.detected | 0)) * 100);
    } else {
      setProgress(0);
    }

    // Primary action button states
    if (els.primaryBtn) {
      if (st === "running") {
        els.primaryBtn.textContent = "Pause";
        els.primaryBtn.className = "btn-action primary btn-pause";
        els.primaryBtn.disabled = false;
        if (els.stopBtn) els.stopBtn.disabled = false;
      } else if (st === "paused") {
        els.primaryBtn.textContent = "Resume";
        els.primaryBtn.className = "btn-action primary btn-resume";
        els.primaryBtn.disabled = false;
        if (els.stopBtn) els.stopBtn.disabled = false;
      } else if (st === "done") {
        els.primaryBtn.textContent = "All done!";
        els.primaryBtn.className = "btn-action primary btn-done";
        els.primaryBtn.disabled = true;
        if (els.stopBtn) els.stopBtn.disabled = true;
      } else {
        els.primaryBtn.textContent = "Start Unfollowing";
        els.primaryBtn.className = "btn-action primary";
        els.primaryBtn.disabled = false;
        if (els.stopBtn) els.stopBtn.disabled = true;
      }
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

    if (els.chkProtectMutuals) els.chkProtectMutuals.checked = !!session.protectMutuals;
    if (els.chkProtectVerified) els.chkProtectVerified.checked = !!session.protectVerified;
    if (els.chkJitter) els.chkJitter.checked = session.jitter !== false;
    if (els.chkSkipAvatars) els.chkSkipAvatars.checked = !!session.skipDefaultAvatars;

    renderWhitelist();
  }

  function renderWhitelist() {
    if (!els.wlList) return;
    els.wlList.innerHTML = "";
    var list = Array.isArray(session.whitelist) ? session.whitelist : [];
    if (list.length === 0) {
      var emptyLi = document.createElement("li");
      emptyLi.className = "wl-empty";
      emptyLi.textContent = "No protected accounts yet. Add handles above to keep them.";
      els.wlList.appendChild(emptyLi);
      return;
    }

    list.forEach(function (h) {
      var li = document.createElement("li");
      li.className = "wl-item";

      var span = document.createElement("span");
      span.className = "wl-handle";
      span.textContent = h;

      var del = document.createElement("button");
      del.type = "button";
      del.className = "wl-del-btn";
      del.innerHTML = "&times;";
      del.title = "Remove from Keep List";
      del.setAttribute("aria-label", "Remove " + h);
      del.addEventListener("click", function (e) {
        e.stopPropagation();
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
          if (els.connText) els.connText.textContent = "No active tab";
          return;
        }
        if (chrome.tabs.sendMessage) {
          try {
            chrome.tabs.sendMessage(t.id, { type: "PING" }, function (resp) {
              if (chrome.runtime.lastError || !resp) {
                if (els.connDot) els.connDot.className = "dot error";
                if (els.connText) els.connText.textContent = "Not connected (refresh x.com)";
                isCurrentTabFollowingPage = false;
              } else {
                if (els.connDot) els.connDot.className = "dot connected";
                if (resp.isFollowingPage) {
                  if (els.connText) els.connText.textContent = "Connected to Following page";
                  isCurrentTabFollowingPage = true;
                } else {
                  if (els.connText) els.connText.textContent = "Connected (navigate to /following)";
                  isCurrentTabFollowingPage = false;
                }
              }
            });
          } catch (e) {
            if (els.connDot) els.connDot.className = "dot error";
            if (els.connText) els.connText.textContent = "Tab not ready";
            isCurrentTabFollowingPage = false;
          }
        }
      });
    } catch (e) {
      if (els.connDot) els.connDot.className = "dot";
      if (els.connText) els.connText.textContent = "No active tab";
      isCurrentTabFollowingPage = false;
    }
  }

  // Map background session schema onto popup session cache
  function mergeSessionData(data) {
    if (!data || typeof data !== "object") return;
    if (typeof data.running === "boolean" || typeof data.paused === "boolean") {
      if (data.running && !data.paused) session.state = "RUNNING";
      else if (data.running && data.paused) session.state = "PAUSED";
      else session.state = data.lastError ? "ERROR" : "IDLE";
    }
    if (typeof data.state === "string") session.state = data.state;
    if (typeof data.mode === "string") session.mode = data.mode;
    if (typeof data.filterMode === "string") session.filterMode = data.filterMode;
    if (typeof data.speed === "string") session.speedPreset = data.speed;
    if (typeof data.speedPreset === "string") session.speedPreset = data.speedPreset;
    if (typeof data.batchSize === "number") session.batchSize = data.batchSize;
    if (typeof data.customDelayMs === "number") session.customMs = data.customDelayMs;
    if (typeof data.customMs === "number") session.customMs = data.customMs;
    if (typeof data.discoveredCount === "number") session.detected = data.discoveredCount;
    if (typeof data.detected === "number") session.detected = data.detected;
    if (typeof data.queuedCount === "number") session.queued = data.queuedCount;
    if (typeof data.queued === "number") session.queued = data.queued;
    if (typeof data.unfollowedCount === "number") session.unfollowed = data.unfollowedCount;
    if (typeof data.unfollowed === "number") session.unfollowed = data.unfollowed;
    if (typeof data.failedCount === "number") session.failed = data.failedCount;
    if (typeof data.failed === "number") session.failed = data.failed;
    if (typeof data.skippedCount === "number") session.skipped = data.skippedCount;
    if (typeof data.skipped === "number") session.skipped = data.skipped;
    if (Array.isArray(data.whitelist)) session.whitelist = data.whitelist;
    if (typeof data.protectMutuals === "boolean") session.protectMutuals = data.protectMutuals;
    if (typeof data.protectVerified === "boolean") session.protectVerified = data.protectVerified;
    if (typeof data.jitter === "boolean") session.jitter = data.jitter;
    if (typeof data.skipDefaultAvatars === "boolean") session.skipDefaultAvatars = data.skipDefaultAvatars;
    if (data.updatedAt) session.updatedAt = data.updatedAt;
  }

  // --- Session IO ------------------------------------------------------------
  function loadSession() {
    safeSend({ type: "GET_SESSION", target: "service-worker" }, function (err, resp) {
      if (err || !resp || !resp.session) {
        // Fallback standard GET_STATUS
        safeSend({ type: "GET_STATUS" }, function (e2, r2) {
          if (r2 && r2.session) mergeSessionData(r2.session);
          else if (r2) mergeSessionData(r2);
          render();
        });
        return;
      }
      mergeSessionData(resp.session);
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
      tabButtons.forEach(function (b) {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");

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
        sendFilterConfig();
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
        safeSend({ type: "START" }, function (err, resp) {
          if (err || (resp && !resp.ok)) {
            if (!isCurrentTabFollowingPage) {
              alert("Please open your X Following page first:\nx.com/[your_username]/following");
            }
          }
        });
      } else if (st === "RUNNING") {
        safeSend({ type: "PAUSE" });
      } else if (st === "PAUSED") {
        safeSend({ type: "RESUME" });
      }
    });
  }

  if (els.pauseBtn) {
    els.pauseBtn.addEventListener("click", function () {
      safeSend({ type: "PAUSE" });
    });
  }

  if (els.resumeBtn) {
    els.resumeBtn.addEventListener("click", function () {
      safeSend({ type: "RESUME" });
    });
  }

  if (els.stopBtn) {
    els.stopBtn.addEventListener("click", function () {
      safeSend({ type: "STOP" });
    });
  }

  if (els.resetBtn) {
    els.resetBtn.addEventListener("click", function () {
      safeSend({ type: "RESET_SESSION", target: "service-worker" }, function () {
        loadSession();
      });
    });
  }

  if (els.filterSel) {
    els.filterSel.addEventListener("change", function () {
      var f = els.filterSel.value;
      session.filterMode = f;
      lastFilterSent = f;
      sendFilterConfig();
      render();
    });
  }

  if (els.chkProtectMutuals) {
    els.chkProtectMutuals.addEventListener("change", function () {
      session.protectMutuals = !!els.chkProtectMutuals.checked;
      sendFilterConfig();
    });
  }

  if (els.chkProtectVerified) {
    els.chkProtectVerified.addEventListener("change", function () {
      session.protectVerified = !!els.chkProtectVerified.checked;
      sendFilterConfig();
    });
  }

  if (els.chkJitter) {
    els.chkJitter.addEventListener("change", function () {
      session.jitter = !!els.chkJitter.checked;
      sendFilterConfig();
    });
  }

  if (els.chkSkipAvatars) {
    els.chkSkipAvatars.addEventListener("change", function () {
      session.skipDefaultAvatars = !!els.chkSkipAvatars.checked;
      sendFilterConfig();
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

  if (els.customDelay) {
    els.customDelay.addEventListener("input", function () {
      var val = parseInt(els.customDelay.value, 10);
      if (!isNaN(val) && val >= 100) {
        session.customMs = val;
        lastCustomSent = val;
        safeSend({ type: "SET_SPEED", payload: { preset: "custom", customMs: val } });
      }
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
      var blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "untwitt-keep-list.csv";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  if (els.exportAuditBtn) {
    els.exportAuditBtn.addEventListener("click", function () {
      safeSend({ type: "GET_STATUS" }, function (err, resp) {
        var rows = "timestamp,type,handle,reason\n";
        if (resp && resp.audit && Array.isArray(resp.audit)) {
          resp.audit.forEach(function (entry) {
            rows += [
              JSON.stringify(entry.timestamp || new Date().toISOString()),
              JSON.stringify(entry.type || ""),
              JSON.stringify(entry.handle || ""),
              JSON.stringify(entry.reason || "")
            ].join(",") + "\n";
          });
        }
        var blob = new Blob([rows], { type: "text/csv;charset=utf-8;" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "untwitt-audit-log.csv";
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  // --- Inbound message handler from service worker & content script ---------
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "STATUS" && msg.payload) {
        mergeSessionData(msg.payload);
        render();
      } else if (msg.type === "STATUS" && msg.session) {
        mergeSessionData(msg.session);
        render();
      } else if (msg.type === "SESSION_UPDATED" && msg.session) {
        mergeSessionData(msg.session);
        render();
      } else if (msg.type === "SESSION_RESET" && msg.session) {
        mergeSessionData(msg.session);
        render();
      } else if (msg.type === "ACCOUNT_DISCOVERED" && typeof msg.count === "number") {
        session.detected = msg.count;
        render();
      } else if (msg.type === "ACCOUNT_QUEUED" && typeof msg.count === "number") {
        session.queued = msg.count;
        render();
      } else if (msg.type === "ACCOUNT_UNFOLLOWED" && typeof msg.count === "number") {
        session.unfollowed = msg.count;
        render();
      } else if (msg.type === "ACCOUNT_FAILED" && typeof msg.count === "number") {
        session.failed = msg.count;
        render();
      } else if (msg.type === "ACCOUNT_SKIPPED" && typeof msg.count === "number") {
        session.skipped = msg.count;
        render();
      } else if (msg.type === "COMPLETED") {
        session.state = "DONE";
        render();
      } else if (msg.type === "ERROR") {
        session.state = "ERROR";
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
