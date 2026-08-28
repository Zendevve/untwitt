// untwitt content-script module loader.
// Manifest V3 content scripts run as classic scripts; this loader boots
// the ES module content script via dynamic import().

(function () {
  "use strict";
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    var src = chrome.runtime.getURL("src/content/content.js");
    import(src).catch(function (err) {
      console.error("[untwitt] failed to initialize content module:", err);
    });
  }
})();
