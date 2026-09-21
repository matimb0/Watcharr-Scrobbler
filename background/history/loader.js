/*
 * Find the open tab of a service and pull one page of its history from the
 * content script running there.
 *
 * A service tab that was opened BEFORE the extension was loaded has no content
 * script yet – it is injected here, and that is also the only failure mode the
 * user can act on (missing host permission), so it is reported with its own
 * stable error code.
 */
"use strict";

(function () {
  const { log, logErr } = globalThis.WatcharrUtil;
  const userError = WatcharrErrors.create;

  /**
   * Tabs of one service. Both sources are combined because they fail for
   * different reasons: the registry's URL matching needs a readable tab URL,
   * while the URL pattern is matched by the browser itself and therefore also
   * finds tabs whose URL this context cannot see.
   */
  async function serviceCandidates(svc) {
    const byId = new Map();
    try {
      for (const tab of await browser.tabs.query({})) {
        if (
          tab &&
          tab.id != null &&
          tab.url &&
          WatcharrServices.byUrl(tab.url) === svc
        ) {
          byId.set(tab.id, tab);
        }
      }
    } catch (_) {
      /* listing not available – the pattern query below still applies */
    }
    try {
      for (const tab of await browser.tabs.query({ url: svc.urlPattern })) {
        if (tab && tab.id != null && !byId.has(tab.id)) byId.set(tab.id, tab);
      }
    } catch (_) {
      /* pattern query not available */
    }
    return [...byId.values()];
  }

  /** True when the extension may inject scripts into this service's pages.
   *  Host permissions are optional in Firefox: they can be missing even though
   *  the manifest requests them, and injecting then fails. */
  async function hasHostPermission(svc) {
    if (!browser.permissions || !browser.permissions.contains) return true;
    try {
      return await browser.permissions.contains({ origins: [svc.urlPattern] });
    } catch (_) {
      return true; // cannot check – let the injection report the truth
    }
  }

  /**
   * Finds a tab of `serviceId` where the content script is running, injecting
   * it if needed. Returns the tab id or throws a user-facing error.
   */
  async function ensureServiceTab(serviceId) {
    // The Jellyfin server URL is part of the settings – applying them here makes
    // the service's tab pattern available in the background context.
    WatcharrServices.applySettings(await WatcharrSettings.get());
    const svc = WatcharrServices.byId(serviceId) || WatcharrServices.list[0];

    if (!WatcharrServices.hasTabPattern(svc)) {
      logErr("ensureServiceTab: no server configured for", svc && svc.id);
      throw userError(
        "service_not_configured",
        (svc && svc.name ? svc.name : "The service") +
          " is not configured yet. Add its server URL in the settings.",
        { service: svc && svc.name ? svc.name : "" },
      );
    }

    const candidates = await serviceCandidates(svc);
    log(
      "ensureServiceTab: candidates:",
      candidates.map((t) => t.id + ":" + (t.url || "?")).join(", ") || "(none)",
    );
    if (!candidates.length) {
      logErr("ensureServiceTab: no open", svc.name, "tab found");
      throw userError(
        "no_service_tab",
        "No open " + svc.name + " tab found. Open " + svc.name + " and log in.",
        { service: svc.name },
      );
    }

    // 1) A tab that already runs the content script wins.
    for (const tab of candidates) {
      try {
        await browser.tabs.sendMessage(tab.id, { type: "watcharr:ping" });
        log("ensureServiceTab: content script running in tab", tab.id);
        return tab.id;
      } catch (_) {
        /* no content script in this tab -> try the next one */
      }
    }

    // 2) Otherwise inject it. The injection needs host permission for that
    //    page, so a permission failure has to be told apart from a plain
    //    injection error – only the permission case is actionable.
    const permitted = await hasHostPermission(svc);
    log("ensureServiceTab: no content script | host permission =", permitted);
    if (!permitted && browser.permissions && browser.permissions.getAll) {
      // Decisive when the injection fails: which origins are granted at all?
      try {
        const all = await browser.permissions.getAll();
        log(
          "ensureServiceTab: granted origins:",
          (all.origins || []).join(", ") || "(none)",
        );
      } catch (_) {
        /* diagnostics only */
      }
    }

    let lastError = null;
    let permissionError = false;
    for (const tab of candidates) {
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: svc.contentScripts,
        });
        // Give the injected scripts (and Netflix' MAIN-world probe) a moment
        // to initialise, then check that the tab really answers.
        await new Promise((r) => setTimeout(r, 800));
        try {
          await browser.tabs.sendMessage(tab.id, { type: "watcharr:ping" });
          log("ensureServiceTab: injected into tab", tab.id, tab.url || "?");
          return tab.id;
        } catch (err) {
          lastError = err;
          logErr(
            "ensureServiceTab: injected but not reachable in tab",
            tab.id,
            "->",
            err.message,
          );
        }
      } catch (err) {
        lastError = err;
        if (/host permission/i.test(err.message || "")) permissionError = true;
        logErr(
          "ensureServiceTab: injection failed in tab",
          tab.id,
          "->",
          err.message,
        );
      }
    }

    const reason = (lastError && lastError.message) || String(lastError || "");
    if (permissionError) {
      throw userError(
        "host_permission_missing",
        "Missing access to " + svc.name + ". (" + reason + ")",
        { service: svc.name, reason },
      );
    }
    throw userError(
      "service_tab_prepare",
      svc.name +
        " tab could not be prepared. Please reload the " +
        svc.name +
        " page and try again. (" +
        reason +
        ")",
      { service: svc.name, reason },
    );
  }

  /**
   * One page of the service history, fetched through its content script.
   * `historyLoadId` tells paged services (Prime Video) that a fresh load
   * started, so they reset their internal buffer.
   */
  async function fetchPage(serviceId, historyLoadId, pageIndex) {
    const tabId = await ensureServiceTab(serviceId);
    log("fetchPage: fetching", serviceId, "page", pageIndex, "from tab", tabId);

    const resp = await browser.tabs.sendMessage(tabId, {
      type: "watcharr:fetchHistoryPage",
      page: pageIndex,
      loadId: historyLoadId,
    });

    if (!resp || resp.status !== "ok") {
      // A real reason from the service ("please log in", a blocked host, …) is
      // surfaced through the translated generic wrapper in the UI; the generic
      // code is only used when there is genuinely no reply.
      const reason = (resp && resp.error) || "";
      if (reason) {
        const err = new Error(reason);
        err.userCode = (resp && resp.errorCode) || null;
        err.userParams = (resp && resp.errorParams) || null;
        throw err;
      }
      throw userError(
        "no_service_response",
        "No response from the service tab received.",
      );
    }

    const entries = resp.entries || [];
    log(
      "fetchPage: page",
      pageIndex,
      "->",
      entries.length,
      "entries, done:",
      !!resp.done,
    );
    return { entries, done: !!resp.done };
  }

  globalThis.WatcharrHistoryLoader = { ensureServiceTab, fetchPage };
})();
