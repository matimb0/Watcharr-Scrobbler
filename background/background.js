/*
 * Watcharr Scrobbler – background entry point.
 *
 * Registers the message router and starts the service tracking. The message
 * handling itself lives in background/messages/*.js, one module per topic; the
 * Settings, Watcharr, history and Jellyfin logic lives next to this file.
 */
"use strict";

/** Tried in order; the first module that knows the message type answers it. */
const MESSAGE_HANDLERS = [
  WatcharrMessageSettings,
  WatcharrMessageScrobble,
  WatcharrMessagePrimeVideo,
  WatcharrMessageHistory,
];

async function handleMessage(msg) {
  for (const handler of MESSAGE_HANDLERS) {
    const response = await handler.handle(msg);
    if (response !== undefined) return response;
  }
  return { ok: false, error: "Unknown message type: " + (msg && msg.type) };
}

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error("[watcharr-scrobbler] background error:", err);
      sendResponse(WatcharrErrors.toResponse(err));
    });
  return true; // keep the message channel open for the async response
});

// Bring the dynamically registered Jellyfin content script (and the content
// scripts of already-open service tabs) up to date, then start the central
// service-tab watcher. Runs on every background start – the watcher's listeners
// must be registered synchronously, so the first tab event of a wake-up is not
// missed.
WatcharrServiceTabs.start();
WatcharrJellyfin.sync().catch((err) => {
  console.error("[watcharr-scrobbler] Jellyfin setup failed:", err);
});
