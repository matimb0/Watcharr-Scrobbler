/*
 * Watcharr Scrobbler – central service-tab watcher.
 *
 * Single source of truth for "which supported services (Netflix / Prime Video /
 * Jellyfin) have an open tab, and which one is in front?". Lives in the
 * background so every context (popup, history page) gets the same, always
 * current answer instead of polling the tabs API itself.
 *
 * Stays current through tabs.onCreated/onRemoved/onUpdated (url + complete),
 * tabs.onActivated, windows.onFocusChanged/onRemoved and – on Firefox –
 * tabs.onReplaced. Event bursts are debounced into one recompute and only an
 * actual change is broadcast.
 *
 * It also keeps the per-service content script running in every open service
 * tab (ping, then scripting.executeScript), so a tab that was already open when
 * the extension loaded scrobbles without a manual reload.
 *
 * Public API (global `WatcharrServiceTabs`):
 *   start()             – attach the tab/window listeners (idempotent).
 *   refresh()           – recompute now, resolves with the fresh snapshot.
 *   getSnapshot()       – cached snapshot (never queries tabs).
 *   findServiceTab(id)  – tab id of a service with a running content script.
 *   forgetTab(tabId)    – drop the cached "content script running" flag.
 *
 * Snapshot shape (JSON-safe, used verbatim in messages):
 *   { revision, activeServiceId, openServiceIds,
 *     services: [ { id, name, open, tabs: [ { id, windowId, active, url } ] } ] }
 */
"use strict";

(function () {
  "use strict";

  // A single tab event (open, navigate, activate) fires several listeners;
  // collapsing them into one recompute keeps the tab queries cheap.
  const DEBOUNCE_MS = 150;
  // A run that never finishes (a tabs query that does not settle) must not
  // blind the watcher forever: after this long a fresh run is started.
  const STUCK_RUN_MS = 4000;

  /** Tab ids whose content script answered a ping (a navigation clears them). */
  const readyTabs = new Set();
  /** In-flight injections per tab – parallel callers share one run. */
  const injectionPromises = new Map();

  let started = false;
  let debounceTimer = null;
  // Promise of the run that is currently scanning the tabs (null when idle).
  // Callers that arrive while one is running get THAT result – never the last
  // snapshot, which may predate the very tab change they are asking about.
  let inflight = null;
  let inflightStartedAt = 0;
  let rerunRequested = false;
  let lastSignature = "";
  let revision = 0;
  let snapshot = emptySnapshot();

  function emptySnapshot() {
    return {
      revision: 0,
      activeServiceId: null,
      openServiceIds: [],
      services: [],
    };
  }

  /** The service registry (loaded before this file in every background). */
  function registry() {
    return globalThis.WatcharrServices || null;
  }

  /** Services that can be found in tabs – Jellyfin only once configured. */
  function detectableServices() {
    const S = registry();
    if (!S) return [];
    return (S.list || []).filter((svc) => S.hasTabPattern(svc));
  }

  /** All tabs, reduced to the fields this module needs. */
  async function queryAllTabs() {
    try {
      const tabs = await browser.tabs.query({});
      return (tabs || [])
        .filter((tab) => tab && tab.id != null)
        .map((tab) => ({
          id: tab.id,
          windowId: tab.windowId,
          active: !!tab.active,
          // `status` stays internal – it decides whether injecting is safe.
          status: tab.status || "",
          url: tab.url || "",
        }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Open tabs of one service, matched with the registry's own URL logic
   * (`WatcharrServices.byUrl`) rather than a browser URL pattern: the two do
   * not always agree, and the Jellyfin base path cannot be expressed as a
   * pattern. The tab listing is shared by all services (one query total).
   *
   * A tab only carries its URL when this context may read it – hence the
   * `queryServiceTabs` fallback, which the browser matches itself.
   */
  function tabsOfService(S, svc, tabs) {
    return tabs.filter((tab) => {
      if (!tab.url) return false;
      const match = S ? S.byUrl(tab.url) : null;
      return !!match && match.id === svc.id;
    });
  }

  /** Fallback for tabs the plain listing cannot see: one query per service,
   *  matched by the browser against the service's URL pattern. */
  async function queryServiceTabs(svc) {
    try {
      const tabs = await browser.tabs.query({ url: svc.urlPattern });
      return (tabs || [])
        .filter((tab) => tab && tab.id != null)
        .map((tab) => ({
          id: tab.id,
          windowId: tab.windowId,
          active: !!tab.active,
          // `status` stays internal – it decides whether injecting is safe.
          status: tab.status || "",
          url: tab.url || "",
        }));
    } catch (_) {
      return [];
    }
  }

  /** Id of the service in the tab the user is looking at, or null. */
  async function detectActiveService() {
    const S = registry();
    if (!S) return null;
    let active = null;
    try {
      active = (
        await browser.tabs.query({ active: true, lastFocusedWindow: true })
      )[0];
    } catch (_) {
      /* not every implementation knows `lastFocusedWindow` */
    }
    if (!active) {
      try {
        active = (await browser.tabs.query({ active: true }))[0];
      } catch (_) {
        return null;
      }
    }
    const svc = active && active.url ? S.byUrl(active.url) : null;
    return svc ? svc.id : null;
  }

  /** Fingerprint of "which service tabs exist / which one is in front". */
  function signature(services, activeServiceId) {
    return (
      services
        .map(
          (s) =>
            s.id +
            "=" +
            s.tabs.map((t) => t.id + (t.active ? "*" : "")).join("+"),
        )
        .join("|") +
      "#" +
      (activeServiceId || "")
    );
  }

  /* -------------------------------------------------------------------------
   * Content-script injection
   * ---------------------------------------------------------------------- */

  /**
   * Makes sure the content script of `svc` runs in `tab`: a ping first (cheap,
   * and it proves the script is already there), only then an injection.
   * `force` skips the "wait until the page finished loading" rule.
   * Resolves with true when the tab has a running content script.
   */
  function ensureContentScript(svc, tab, force) {
    if (!svc || !tab || tab.id == null) return Promise.resolve(false);
    if (!Array.isArray(svc.contentScripts) || !svc.contentScripts.length) {
      return Promise.resolve(false);
    }
    if (readyTabs.has(tab.id)) return Promise.resolve(true);
    // A loading page gets its content script from the manifest (Netflix/Prime)
    // or the dynamic registration (Jellyfin); injecting now would race with
    // that. onUpdated ("complete") brings us back.
    if (!force && tab.status && tab.status !== "complete") {
      return Promise.resolve(false);
    }

    let pending = injectionPromises.get(tab.id);
    if (!pending) {
      pending = injectNow(svc, tab).finally(() =>
        injectionPromises.delete(tab.id),
      );
      injectionPromises.set(tab.id, pending);
    }
    return pending;
  }

  async function injectNow(svc, tab) {
    try {
      await browser.tabs.sendMessage(tab.id, { type: "watcharr:ping" });
      readyTabs.add(tab.id);
      return true;
    } catch (_) {
      /* no content script in this tab yet -> inject below */
    }
    if (!browser.scripting || !browser.scripting.executeScript) return false;
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: svc.contentScripts,
      });
      readyTabs.add(tab.id);
      return true;
    } catch (_) {
      /* page not injectable – the registered content script covers it */
      return false;
    }
  }

  /* -------------------------------------------------------------------------
   * Snapshot / broadcast
   * ---------------------------------------------------------------------- */

  /** Scans the tabs and rebuilds the snapshot (broadcasts on a real change). */
  async function computeSnapshot() {
    const S = registry();
    // One listing for all services; the per-service pattern query stays as a
    // second source because the browser matches it itself and therefore also
    // sees tabs whose URL this context cannot read (see tabsOfService).
    const allTabs = await queryAllTabs();
    const services = [];
    for (const svc of detectableServices()) {
      let tabs = tabsOfService(S, svc, allTabs);
      if (!tabs.length) tabs = await queryServiceTabs(svc);
      services.push({ id: svc.id, name: svc.name, tabs });
    }
    const activeServiceId = await detectActiveService();

    const sig = signature(services, activeServiceId);
    const changed = sig !== lastSignature;
    if (changed) {
      lastSignature = sig;
      revision += 1;
    }

    snapshot = {
      revision,
      activeServiceId,
      openServiceIds: services.filter((s) => s.tabs.length).map((s) => s.id),
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        open: s.tabs.length > 0,
        tabs: s.tabs.map((t) => ({
          id: t.id,
          windowId: t.windowId,
          active: t.active,
          url: t.url,
        })),
      })),
    };

    // Only a real change is worth telling the extension pages about.
    if (changed) broadcast();

    // Keep the content scripts of all open service tabs alive. Fire & forget:
    // open tabs must never be blocked by an injection.
    for (const svc of services) {
      const descriptor = S ? S.byId(svc.id) : null;
      for (const tab of svc.tabs) ensureContentScript(descriptor, tab);
    }

    return snapshot;
  }

  /**
   * Recomputes the snapshot; concurrent calls share one run.
   *
   * A caller arriving while a run is in flight gets that run's result *and*
   * triggers one more run afterwards: the run in flight may have started before
   * the change the caller cares about (a service tab still loading its URL, for
   * example), so the cached snapshot could already be outdated.
   */
  function recompute() {
    const stuck = inflight && Date.now() - inflightStartedAt > STUCK_RUN_MS;
    if (inflight && !stuck) {
      rerunRequested = true;
      return inflight;
    }
    inflightStartedAt = Date.now();
    const run = computeSnapshot().catch((err) => {
      // A failed scan must never kill the watcher – keep the last snapshot.
      console.error("[watcharr-scrobbler] service tab scan failed:", err);
      return snapshot;
    });
    inflight = run.finally(() => {
      inflight = null;
      if (rerunRequested) {
        rerunRequested = false;
        schedule(0);
      }
    });
    return inflight;
  }

  /** Tells every open extension page (popup, history) about the new state. */
  function broadcast() {
    try {
      const result = browser.runtime.sendMessage({
        type: "watcharr:serviceTabs:changed",
        revision: snapshot.revision,
        activeServiceId: snapshot.activeServiceId,
        openServiceIds: snapshot.openServiceIds,
        services: snapshot.services,
      });
      // Nobody listening (no popup / history page open) is the normal case.
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {
      /* extension context is shutting down */
    }
  }

  function schedule(delay) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(
      () => {
        debounceTimer = null;
        // A failed recompute must never kill the watcher.
        Promise.resolve(recompute()).catch(() => {});
      },
      typeof delay === "number" ? delay : DEBOUNCE_MS,
    );
  }

  /* -------------------------------------------------------------------------
   * Public API
   * ---------------------------------------------------------------------- */

  /** Attaches the tab/window listeners (safe to call on every wake-up). */
  function start() {
    if (started) return;
    started = true;
    try {
      browser.tabs.onCreated.addListener(() => schedule());
      browser.tabs.onRemoved.addListener((tabId) => {
        readyTabs.delete(tabId); // the id may be reused by a later tab
        schedule();
      });
      browser.tabs.onActivated.addListener(() => schedule());
      browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (!changeInfo) return;
        // A navigation replaces the page – and with it the content script.
        if (changeInfo.url) readyTabs.delete(tabId);
        // A newly opened tab reports "loading" first – often BEFORE its URL is
        // known. Reacting to that too picks the tab up the moment it becomes a
        // service tab; otherwise an opening without a URL change would stay
        // invisible until the page finished loading. (The debounce keeps the
        // extra queries cheap.)
        if (changeInfo.url || changeInfo.status) schedule();
      });
      browser.windows.onFocusChanged?.addListener(() => schedule());
      browser.windows.onRemoved?.addListener(() => schedule());
    } catch (_) {
      /* tab events are not available in this context */
    }
    schedule(0);
  }

  /**
   * Recomputes now (cancels a pending debounce) and resolves with the fresh
   * state. Waits for a run that is already in flight first: a caller asking
   * "which services are open right now?" must not get the result of a scan that
   * started before the change it wants to know about.
   */
  async function refresh() {
    while (inflight) await inflight.catch(() => {});
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return recompute();
  }

  /** Cached snapshot – never touches the tabs API. */
  function getSnapshot() {
    return snapshot;
  }

  /** Drops the cached "content script is running" flag of a tab. Used when a
   *  message to that tab failed although it was considered ready (the script
   *  was unloaded / the page was replaced) – the next lookup re-injects it. */
  function forgetTab(tabId) {
    readyTabs.delete(tabId);
  }

  /**
   * Tab of `serviceId` that has a running content script (injects it if
   * needed), preferring the focused tab of that service. Returns the tab id,
   * or null when the service has no open tab at all.
   */
  async function findServiceTab(serviceId) {
    const S = registry();
    const svc = S ? S.byId(serviceId) : null;
    if (!svc) return null;
    const current = await refresh();
    const entry =
      (current.services || []).find((s) => s.id === svc.id && s.open) || null;
    if (!entry || !entry.tabs.length) return null;
    const tab = entry.tabs.find((t) => t.active) || entry.tabs[0];
    // force: the caller needs a working content script NOW, even if the page
    // is still loading (the injection is idempotent, see the content scripts).
    await ensureContentScript(svc, tab, true);
    return tab.id;
  }

  globalThis.WatcharrServiceTabs = {
    start,
    refresh,
    getSnapshot,
    findServiceTab,
    forgetTab,
  };
})();
