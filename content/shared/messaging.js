/*
 * The message surface every service content script answers.
 *
 * The background service-tab watcher pings tabs with `watcharr:ping`, the popup
 * asks for the current item and the history page pulls one history page at a
 * time.
 */
"use strict";

(function () {
  /**
   * Registers the listeners.
   *
   * @param handlers { getSummary(), fetchHistoryPage(page, loadId) }
   *
   * `fetchHistoryPage` may throw; its message and the optional stable code
   * (`userCode`) plus params (`userParams`) are passed on untranslated – the
   * history page maps the codes to localized text (see history/history.js).
   */
  function listen(handlers) {
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      const type = msg && msg.type;

      // Ping: proves that this content script runs in the tab.
      if (type === "watcharr:ping") {
        sendResponse({ status: "ok" });
        return false;
      }

      if (type === "watcharr:getCurrentItem") {
        sendResponse(handlers.getSummary());
        return false;
      }

      if (type === "watcharr:fetchHistoryPage") {
        Promise.resolve()
          .then(() => handlers.fetchHistoryPage(msg.page || 0, msg.loadId))
          .then(sendResponse)
          .catch((err) => {
            sendResponse({
              status: "error",
              error: (err && err.message) || String(err),
              errorCode: (err && err.userCode) || null,
              errorParams: (err && err.userParams) || null,
            });
          });
        return true; // asynchronous response
      }

      return false;
    });
  }

  globalThis.WatcharrContentMessaging = { listen };
})();
