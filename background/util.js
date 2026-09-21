/*
 * Small helpers shared by the background scripts (dates, titles, logging).
 */
"use strict";

(function () {
  const log = (...args) => console.log("[watcharr-bg]", ...args);
  const logErr = (...args) => console.error("[watcharr-bg]", ...args);

  /** Lower-cased, whitespace-collapsed title (comparisons and cache keys). */
  function normTitle(s) {
    return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /**
   * ISO-8601 string for a date value. Never assume a `Date` instance survives
   * the message channel – it may already be a string or a number, so
   * `.toISOString()` is never called on the raw value.
   */
  function toIsoDateString(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    const date = new Date(v); // ISO-8601 string or numeric ms
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  /** ISO-8601 string that is `minutes` before `iso`, or null. */
  function subtractMinutes(iso, minutes) {
    if (iso == null) return null;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    return new Date(date.getTime() - minutes * 60000).toISOString();
  }

  /** "season:episode" key for the per-episode maps. */
  function epKey(season, episode) {
    return Number(season) + ":" + Number(episode);
  }

  /** Whole seconds of an ISO date (tolerates server-side ms truncation). */
  function toEpochSeconds(iso) {
    if (iso == null) return null;
    const t = new Date(iso).getTime();
    return isNaN(t) ? null : Math.floor(t / 1000);
  }

  /** RFC 4122 v4 UUID (with a fallback for contexts without crypto.randomUUID). */
  function uuid() {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /**
   * Decodes the `username`/`type` claims out of a Watcharr JWT. The signature
   * is NOT verified – the token comes from the server we just logged in to and
   * is only used to show the user name.
   */
  function decodeJwtClaims(token) {
    try {
      const base64 = String(token)
        .split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const json = decodeURIComponent(
        atob(padded)
          .split("")
          .map((ch) => "%" + ("00" + ch.charCodeAt(0).toString(16)).slice(-2))
          .join(""),
      );
      return JSON.parse(json) || {};
    } catch (_) {
      return {};
    }
  }

  globalThis.WatcharrUtil = {
    log,
    logErr,
    normTitle,
    toIsoDateString,
    subtractMinutes,
    epKey,
    toEpochSeconds,
    uuid,
    decodeJwtClaims,
  };
})();
