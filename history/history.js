/*
 * Watcharr Scrobbler – history page.
 *
 * Shows the viewing history of the selected service (Netflix / Prime Video /
 * Jellyfin) as a comparison "service ↔ Watcharr", allows correcting the matches
 * (Watcharr search) and importing selected titles.
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const I18NApi = window.i18n || {
  resolveLanguage: (lang) => (lang === "de" ? "de" : "en"),
  loadLanguage: async (lang) => (lang === "de" ? "de" : "en"),
  translate: async (key, lang, params = {}) => key,
  applyTranslations: async () => {},
};

let currentLanguage = I18NApi.resolveLanguage("en");

async function t(key, params = {}) {
  return I18NApi.translate
    ? I18NApi.translate(key, currentLanguage, params)
    : key;
}

// Synchronous translation for use while building HTML/status strings.
function ts(key, params) {
  return window.watcharrI18n && window.watcharrI18n.tSync
    ? window.watcharrI18n.tSync(key, params || {}, currentLanguage)
    : key;
}

// Diagnostic logging, temporarily ON by default while the report "a service tab
// was opened but the header did not update" is investigated. Individual sessions
// can turn it off with `?debug=0` in the URL or `localStorage.watcharrDebug =
// "0"`; `= "1"` forces it on. (Fallback below back to `false` before release.)
const DEBUG = (() => {
  try {
    const flag = new URLSearchParams(location.search).get("debug");
    if (flag != null) return flag !== "0";
    const stored = localStorage.getItem("watcharrDebug");
    if (stored != null) return stored !== "0";
  } catch (_) {
    /* no URL/localStorage available – use the default below */
  }
  return true; // TEMPORARY default while debugging
})();

function dbg(...args) {
  if (DEBUG) console.log("[watcharr-scrobbler:history]", ...args);
}

// Stable error codes from the background (background/errors.js users:
// messages/*.js and history/*.js) mapped to translation keys, so extension-
// authored error text is localized instead of shown raw. Unknown/arbitrary
// (server) messages fall back to the translated generic wrapper below.
const ERROR_KEYS = {
  not_configured: "history.error.notConfigured",
  no_service_tab: "history.error.noServiceTab",
  service_tab_prepare: "history.error.serviceTabPrepare",
  // Host permissions are optional in Firefox: the manifest only requests them,
  // and without them a service tab cannot be read or injected into.
  host_permission_missing: "history.error.hostPermission",
  service_not_configured: "history.error.serviceNotConfigured",
  no_service_response: "history.error.noResponse",
  auth_failed: "history.error.authFailed",
  no_match: "history.error.noMatch",
  create_failed: "history.error.createFailed",
  export_running: "history.error.exportRunning",
  history_busy: "history.error.historyBusy",
  file_unreadable: "history.error.fileUnreadable",
  file_empty: "history.error.fileEmpty",
  tmdb_not_found: "history.error.tmdbNotFound",
  // Jellyfin (content/jellyfin/jellyfin-content.js)
  jellyfin_not_logged_in: "history.error.jellyfinNotLoggedIn",
  jellyfin_unavailable: "history.error.jellyfinUnavailable",
  jellyfin_api_failed: "history.error.jellyfinApiFailed",
};

// TMDB multi-search result types shown in the "change match" popover.
const SEARCH_TYPE_KEYS = {
  movie: "history.metadataMovie",
  tv: "history.metadataSeries",
  person: "history.metadataPerson",
};

/** Localized label of a TMDB search-result type ("movie"/"tv"/"person"). */
function searchTypeLabel(type) {
  return (SEARCH_TYPE_KEYS[type] && ts(SEARCH_TYPE_KEYS[type])) || type;
}

/** TMDB page of a search result ("movie" | "tv" | "person"), or null. */
function tmdbUrl(result) {
  const id = Number(result && result.ids && result.ids.tmdb);
  if (!Number.isInteger(id) || id <= 0) return null;
  const kind = { tmdb_movie: "movie", tmdb_tv: "tv", tmdb_person: "person" }[
    result.type
  ];
  return kind ? "https://www.themoviedb.org/" + kind + "/" + id : null;
}

/** Full translated text for an error that may carry { errorCode, errorParams }
 *  (a background response or a locally thrown Error). `fallbackKey` is used
 *  when nothing usable is available. */
async function describeError(err, fallbackKey) {
  if (err && err.errorCode && ERROR_KEYS[err.errorCode]) {
    const params = Object.assign({}, (err && err.errorParams) || {});
    // Messages about host access name the concrete service. Codes that carry
    // their own service (the background knows the tab it talked to) keep it.
    if (params.service === undefined) params.service = serviceLabel();
    return t(ERROR_KEYS[err.errorCode], params);
  }
  const raw = (err && (err.error || err.message)) || "";
  // A fetch blocked by the browser surfaces as "NetworkError …". That is
  // almost always missing host access – telling the user to try again would be
  // useless, so the actionable hint replaces the raw browser message. It names
  // the service whose history is being loaded.
  if (/NetworkError|Network Error|Failed to fetch/i.test(raw)) {
    return t("history.error.networkBlocked", { service: serviceLabel() });
  }
  if (raw) return t("history.error.generic", { reason: raw });
  return t(fallbackKey || "history.loadingFailed");
}

/** Row-level caption: translated for known codes (matchErrorCode/errorCode),
 *  otherwise the raw server message is kept (data, not UI copy). */
function rowErrorText(it, useMatchError) {
  const code = useMatchError ? it.matchErrorCode : it.errorCode;
  const raw = useMatchError ? it.matchError : it.error;
  if (code && ERROR_KEYS[code]) return ts(ERROR_KEYS[code]);
  return raw || "";
}

async function applyLanguage(lang) {
  currentLanguage = I18NApi.resolveLanguage(lang);
  await I18NApi.applyTranslations(currentLanguage, document);
  document.documentElement.lang = currentLanguage;
  // Labels that depend on the CURRENT state (display order, matching mode,
  // file mode) are not part of the static data-i18n sweep – refresh them here
  // so they follow a language change as well.
  updateViewMenu();
  updateSourceUI();
}

const els = {
  reloadBtn: $("#reloadBtn"),
  statusBar: $("#statusBar"),
  selectAllBtn: $("#selectAllBtn"),
  selectNoneBtn: $("#selectNoneBtn"),
  filterBox: $("#filterBox"),
  importBtn: $("#importBtn"),
  // Top bar: the buttons that stay in the bar plus the two dropdown menus
  // ("view" = display order + matching mode, "data" = export/import).
  viewBtn: $("#viewBtn"),
  viewMenu: $("#viewMenu"),
  orderNewestBtn: $("#orderNewestBtn"),
  orderOldestBtn: $("#orderOldestBtn"),
  matchExactBtn: $("#matchExactBtn"),
  matchRoughBtn: $("#matchRoughBtn"),
  dataBtn: $("#dataBtn"),
  dataMenu: $("#dataMenu"),
  fileBtn: $("#fileBtn"),
  fileInput: $("#fileInput"),
  backGroup: $("#backGroup"),
  backBtn: $("#backBtn"),
  confirmModal: $("#confirmModal"),
  orderOkBtn: $("#orderOkBtn"),
  orderCancelBtn: $("#orderCancelBtn"),
  exportBtn: $("#exportBtn"),
  exportModal: $("#exportModal"),
  exportProgress: $("#exportProgress"),
  exportOkBtn: $("#exportOkBtn"),
  exportCancelBtn: $("#exportCancelBtn"),
  exportEnrich: $("#exportEnrich"),
  exportEnrichHint: $("#exportEnrichHint"),
  serviceBtn: $("#serviceBtn"),
  pageTitle: $("#pageTitle"),
  pageSubtitle: $("#pageSubtitle"),
  list: $("#list"),
};

// Service whose history is currently shown (id from WatcharrServices).
let serviceId = "netflix";
let serviceAvailable = false;
// Services with an open tab (the header toggle switches between them).
let availableServices = [];
// Settings this page was opened with (Jellyfin server, Watcharr URL). They
// decide which host access has to be requested – see neededOrigins().
let loadedSettings = null;

const TMDB_IMG = "https://image.tmdb.org/t/p/w185";

let items = []; // current (filtered) view
let allItems = []; // all loaded items
let filter = "";
let fileName = ""; // name of the loaded file (file mode only)
const PREFETCH_THRESHOLD = 5; // reload when only this many rows are left at bottom
let total = 0; // number of titles loaded so far
let allLoaded = false; // complete Netflix history loaded?
let loadingMore = false; // currently loading more?
// Lock while an initial full load is running (e.g. switching to "oldest
// first"): blocks infinite scroll / parallel loads until it has finished.
let loadingInitial = false;
// Lock while the complete history is being exported to a file: the service
// page crawl in the background belongs to the export, so no load may run at
// the same time.
let exporting = false;
// Generation counter: incremented on every fresh load() so that a still
// pending "load more" response from an older list can be discarded.
let loadGen = 0;
// Session-only display order: false = newest first (default, incremental),
// true = oldest first (the complete history is loaded once, oldest on top).
let oldestFirst = false;
// Session-only matching mode: true = exact (a Netflix row only counts as
// "recorded" when the FINISHED activity matches date AND time), false =
// rough (only checks whether the episode is already watched/finished).
let exactMatch = true;
// Import from a file: while set, the list is fed by the loaded export instead
// of the open service tab (`loadedFile` keeps the file content so that
// switching the order can re-send it to the background).
let fileMode = false;
let loadedFile = null; // { text, name }

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Builds DOM nodes from an HTML string that was composed in this file with
// every dynamic value passed through escapeHtml(). DOMParser never executes
// scripts; the parsed nodes are attached directly instead of using innerHTML.
function replaceFromHtml(element, html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  element.replaceChildren();
  for (const node of Array.from(parsed.body.childNodes)) {
    element.appendChild(node);
  }
}

let statusTimer = null; // Auto-hide timer for success popup

function setStatus(kind, text) {
  clearTimeout(statusTimer);
  els.statusBar.className = "status " + kind;
  els.statusBar.textContent = text;
  els.statusBar.classList.remove("hidden");
}

function clearStatus() {
  clearTimeout(statusTimer);
  els.statusBar.classList.add("hidden");
  els.statusBar.classList.remove("popup");
  els.statusBar.textContent = "";
}

/** Shows the status bar as a small popup above the toolbar, fades out after 4 s. */
function showStatusPopup(kind, text) {
  clearTimeout(statusTimer);
  els.statusBar.className = "status " + kind + " popup";
  els.statusBar.textContent = text;
  els.statusBar.classList.remove("hidden");
  statusTimer = setTimeout(hideStatusPopup, 4000);
}

/** Fades out the popup smoothly and removes it afterwards. */
function hideStatusPopup() {
  if (!els.statusBar.classList.contains("popup")) return;
  els.statusBar.classList.add("popup-hide"); // starts the fade-out
  statusTimer = setTimeout(() => {
    els.statusBar.classList.add("hidden");
    els.statusBar.classList.remove("popup", "popup-hide");
    els.statusBar.textContent = "";
  }, 300);
}

function posterUrl(it) {
  return it && it.match && it.match.posterPath
    ? TMDB_IMG + it.match.posterPath
    : null;
}

/** Rough check: is the episode already watched in Watcharr at all?
 * (FINISHED or WATCHING counts as watched.) */
function episodeSeen(status) {
  return status === "FINISHED" || status === "WATCHING";
}

/** The episode itself is FINISHED in Watcharr (independent of the date). */
function episodeFinished(it) {
  return !!(
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown &&
    it.episodeStatus === "FINISHED"
  );
}

/** True only when this Netflix row is already recorded in Watcharr at the
 * exact same date+time: the episode has a FINISHED activity (EPISODE_ADDED /
 * EPISODE_STATUS_CHANGED) whose customDate matches the row's date+time.
 * customDate is the watched date that was passed to the API. */
function episodeRecordedAtDate(it) {
  return !!(
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown &&
    it.episodeDateMatched
  );
}

/** "S1E2" for an episode row, otherwise "". Season 0 (specials) is valid. */
function episodeLabel(it) {
  return it.isTv && it.season != null && it.episode != null
    ? "S" + it.season + "E" + it.episode
    : "";
}

/** Already transferred rows are not selectable. */
function isTransferred(it) {
  if (!it || !it.match) return false;
  // Successfully imported in this session.
  if (it.status === "imported" || it.status === "updated") {
    return true;
  }
  // Failed/skipped import remains editable (e.g., retry import).
  if (it.status === "error" || it.status === "skipped") {
    return false;
  }
  // Match is not yet in Watcharr -> selectable.
  if (!it.match.watchedId) return false;
  // Series with known episode: the decision depends on the matching mode.
  if (
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown
  ) {
    // Exact: only the identical watch (same date AND time) is transferred.
    // Rough: any watched/finished episode is transferred.
    return exactMatch
      ? episodeRecordedAtDate(it)
      : episodeSeen(it.episodeStatus);
  }
  // Movie or series without known episode / unknown status -> already in Watcharr.
  return true;
}

/** One badge (`cls` picks the color: ok | add | readd | warn | problem).
 *  `title` adds an optional tooltip with a short explanation. */
function badge(cls, text, title) {
  return (
    '<span class="badge ' +
    cls +
    '"' +
    (title ? ' title="' + escapeHtml(title) + '"' : "") +
    ">" +
    escapeHtml(text) +
    "</span>"
  );
}

/**
 * Result of an import run ("Import selected"). It REPLACES the row status
 * afterwards – the import result is the newest state of the row.
 */
function importBadge(it) {
  const map = {
    imported: ["imported", "history.statusImported"],
    updated: ["imported", "history.statusUpdated"],
    skipped: ["warn", "history.statusSkipped"],
    error: ["error", "history.statusError"],
  };
  const entry = it.status && map[it.status];
  return entry ? badge(entry[0], ts(entry[1])) : "";
}

/**
 * THE status of a row: exactly one badge saying what happens to this watch.
 * Deliberately kept simple – the technical difference between "the series is
 * not in Watcharr yet" and "only this episode is not recorded yet" makes no
 * difference for the user, both mean the watch still gets added:
 *
 *   already recorded          -> green  (nothing to do)
 *   watched, but not this date-> teal   (only this watch date gets added)
 *   anything else             -> blue   (the watch gets added)
 *   nothing matched           -> red    (must be corrected by hand)
 */
function rowBadge(it) {
  const imported = importBadge(it);
  if (imported) return imported;
  if (!it.match) return badge("problem", ts("history.badgeNoMatch"));
  // Already watched, but this exact date is not recorded -> the import adds
  // the date instead of the watch itself.
  if (
    exactMatch &&
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown &&
    episodeFinished(it) &&
    !episodeRecordedAtDate(it)
  ) {
    return badge("readd", ts("history.badgeReadd"));
  }
  return isTransferred(it)
    ? badge("ok", ts("history.badgeRecorded"))
    : badge("add", ts("history.badgeWillAdd"));
}

/**
 * Yellow hints about the QUALITY of the match (next to the status badge): the
 * match had to be guessed, or the matched entry is from another year. Both
 * carry a tooltip explaining what exactly has to be checked.
 */
function matchWarnings(it) {
  const out = [];
  if (matchAmbiguous(it)) {
    out.push(
      badge("warn", ts("history.badgeCheck"), ts("history.badgeCheckTitle")),
    );
  }
  if (yearMismatch(it)) {
    out.push(
      badge(
        "warn",
        ts("history.badgeYearMismatch", { matchYear: it.match.year }),
        ts("history.badgeYearMismatchTitle", {
          providerYear: it.providerYear,
          matchYear: it.match.year,
        }),
      ),
    );
  }
  return out.join("");
}

/** Locale tag for date/time formatting (follows the UI language). */
function localeTag() {
  return currentLanguage === "de"
    ? "de-DE"
    : currentLanguage === "fr"
      ? "fr-FR"
      : currentLanguage === "es"
        ? "es-ES"
        : "en-US";
}

/** Date AND time: the provider reports the exact watch time, and the exact
 *  matching mode compares date + time, so both belong on the provider side. */
function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return (
    d.toLocaleDateString(localeTag()) +
    " " +
    d.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" })
  );
}

/**
 * PROVIDER side of a row: strictly what the service reported. It never reads
 * `it.match`, so correcting/changing the Watcharr match cannot change the left
 * side (title, year, episode and date stay the service's own data).
 */
function providerMeta(it) {
  const parts = [
    it.isTv ? ts("history.metadataSeries") : ts("history.metadataMovie"),
  ];
  if (it.providerYear) parts.push(String(it.providerYear));
  const at = formatDateTime(it.date);
  if (at) parts.push(ts("history.metadataOn", { date: at }));
  return parts.join(" · ");
}

/** Episode line of the provider side: "S1E2 · Episode title" (whichever part
 *  the service knows). */
function providerEpisode(it) {
  return [episodeLabel(it), it.episodeTitle].filter((p) => !!p).join(" · ");
}

/** The match had to be guessed (several same-titled entries, no year known).
 *  Shown on the Watcharr side as a hint to verify the match by hand. */
function matchAmbiguous(it) {
  return !!(it.match && it.match.ambiguous) && !yearMismatch(it);
}

/** Year of the provider entry and of the matched Watcharr entry differ.
 *  Shown on the Watcharr side so a same-titled medium from another year is
 *  visible instead of silently imported. */
function yearMismatch(it) {
  if (!it.match || !it.match.year || !it.providerYear) return false;
  return String(it.providerYear) !== String(it.match.year);
}

function rowHtml(it) {
  const url = posterUrl(it);
  const poster =
    url != null
      ? '<img class="poster" src="' +
        escapeHtml(url) +
        '" alt="" loading="lazy" />'
      : '<div class="poster ph">—</div>';
  const matchName = it.match ? it.match.name || it.title : "—";
  // Episode rows: the concrete episode belongs on the Watcharr side too, so
  // the comparison shows WHICH episode of the matched series is meant (with the
  // TMDB episode name, when Watcharr knows the season).
  const epLabel = episodeLabel(it);
  const matchEp = [epLabel, it.matchEpisodeName].filter((p) => !!p).join(" · ");
  const matchMeta = it.match
    ? "TMDB " +
      it.match.tmdbId +
      (it.match.contentType === "movie"
        ? " · " + ts("history.metadataMovie")
        : " · " + ts("history.metadataSeries")) +
      (it.match.year ? " · " + it.match.year : "")
    : rowErrorText(it, true) || "—";
  // Exact matching mode: the Watcharr side ALWAYS shows a watch date – the one
  // Watcharr already holds for this watch, or, when the watch (respectively just
  // this date) is not recorded yet, the date that is stored on import (the
  // provider's own date). Rough mode does not compare dates, so it shows none.
  const recordedDate = exactMatch ? it.watcharrDate : null;
  const pendingDate = exactMatch && !recordedDate && it.date ? it.date : null;
  const matchDateValue = recordedDate || pendingDate;
  const matchDate = matchDateValue
    ? ts("history.metadataOn", { date: formatDateTime(matchDateValue) })
    : "";

  const providerEp = providerEpisode(it);
  const transferred = isTransferred(it);
  return (
    '<div class="row' +
    (transferred ? " transferred" : "") +
    '" data-key="' +
    escapeHtml(it.key) +
    '">' +
    '<label class="check"><input type="checkbox" class="sel" ' +
    (it.selected ? "checked" : "") +
    (transferred ? " disabled" : "") +
    " /></label>" +
    '<div class="provider">' +
    '<div class="name">' +
    escapeHtml(it.title) +
    "</div>" +
    (providerEp
      ? '<div class="episode">' + escapeHtml(providerEp) + "</div>"
      : "") +
    '<div class="meta">' +
    escapeHtml(providerMeta(it)) +
    "</div>" +
    "</div>" +
    '<div class="arrow">→</div>' +
    '<div class="watcharr">' +
    poster +
    '<div class="info">' +
    '<div class="name">' +
    escapeHtml(matchName) +
    "</div>" +
    (matchEp ? '<div class="episode">' + escapeHtml(matchEp) + "</div>" : "") +
    '<div class="meta">' +
    escapeHtml(matchMeta) +
    "</div>" +
    // Own line: the watch date Watcharr holds (or the one the import stores).
    (matchDate
      ? '<div class="meta date">' + escapeHtml(matchDate) + "</div>"
      : "") +
    '<div class="badges">' +
    rowBadge(it) +
    matchWarnings(it) +
    "</div>" +
    (it.error
      ? '<div class="row-error">' +
        escapeHtml(rowErrorText(it, false)) +
        "</div>"
      : "") +
    "</div>" +
    "</div>" +
    '<div class="row-actions">' +
    '<button class="ghost rematch-btn">' +
    escapeHtml(ts("history.changeMatch")) +
    "</button>" +
    "</div>" +
    "</div>"
  );
}

let hintEl = null; // Hint at list end (Infinite Scroll)
let scrollTriggers = []; // last PREFETCH_THRESHOLD .row elements

function ensureHint() {
  if (!hintEl || !hintEl.isConnected) {
    hintEl = document.createElement("div");
    hintEl.className = "list-hint";
    els.list.appendChild(hintEl);
  }
  return hintEl;
}

function updateHint() {
  const h = ensureHint();
  if (loadingMore) {
    h.textContent = ts("history.loadingMore");
  } else if (allLoaded) {
    h.textContent = ts("history.allLoaded", { total });
  } else {
    h.textContent = ts("history.scrollMore");
  }
}

function buildRow(it) {
  const wrap = document.createElement("div");
  replaceFromHtml(wrap, rowHtml(it));
  return wrap.firstChild;
}

/** Remembers the last rows as triggers for loading more when scrolling. */
function refreshScrollTriggers() {
  const rows = els.list.querySelectorAll(".row");
  const start = Math.max(0, rows.length - PREFETCH_THRESHOLD);
  scrollTriggers = Array.prototype.slice.call(rows, start);
}

/** Filter match: the provider title (left side) and, when present, also the
 *  Watcharr name of the match – a row stays findable under both names. */
function matchesFilter(it) {
  if (!filter) return true;
  const provider = String(it.title || "").toLowerCase();
  const matched =
    it.match && it.match.name ? String(it.match.name).toLowerCase() : "";
  return provider.includes(filter) || matched.includes(filter);
}

function render() {
  items = allItems.filter(matchesFilter);
  els.list.innerHTML = "";
  hintEl = null;
  if (!items.length) {
    const emptyText = allItems.length
      ? ts("history.emptyFilter", { filter })
      : allLoaded
        ? ts("history.emptyHistory")
        : ts("history.reloadHint");
    replaceFromHtml(
      els.list,
      '<div class="list-hint">' + escapeHtml(emptyText) + "</div>",
    );
    updateImportButton();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(buildRow(it));
  els.list.appendChild(frag);
  updateHint();
  refreshScrollTriggers();
  updateImportButton();
}

/** Appends new items to end of list without re-rendering the whole list. */
function appendItems(newItems) {
  const filtered = newItems.filter(matchesFilter);
  items.push(...filtered);
  if (!filtered.length) {
    updateHint();
    updateImportButton();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of filtered) frag.appendChild(buildRow(it));
  const hint = ensureHint();
  els.list.insertBefore(frag, hint);
  updateHint();
  refreshScrollTriggers();
  updateImportButton();
}

function updateImportButton() {
  const n = allItems.filter((it) => it.selected && !isTransferred(it)).length;
  els.importBtn.disabled = n === 0;
  els.importBtn.textContent = ts("history.importSelected", { count: n });
}

// -- Top bar menus ------------------------------------------------------------
// Two dropdowns keep the bar narrow: "view" (display order + matching mode)
// and "data" (export the service history / import a file). Only one is open at
// a time; a click outside, Esc or picking an entry closes it again.

/** The (button, menu) pairs of the top bar. */
const MENUS = [
  { btn: "viewBtn", menu: "viewMenu" },
  { btn: "dataBtn", menu: "dataMenu" },
];

/** Opens one menu (or, with `null`, closes both) and keeps `aria-expanded`
 *  in sync with what is actually visible. */
function openMenu(name) {
  for (const m of MENUS) {
    const open = m.btn === name;
    els[m.menu].classList.toggle("hidden", !open);
    els[m.btn].setAttribute("aria-expanded", String(open));
  }
}

function closeMenus() {
  openMenu(null);
}

/** Whether one of the menus is currently open. */
function anyMenuOpen() {
  return MENUS.some((m) => !els[m.menu].classList.contains("hidden"));
}

/** Click on a bar button: toggles its own menu and closes the other one. */
function toggleMenu(name) {
  if (els[name].getAttribute("aria-expanded") === "true") closeMenus();
  else openMenu(name);
}

// Closing on a click outside: the menu buttons themselves live inside
// `.menu-wrap`, so they keep their own click handling.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) closeMenus();
});

/** Sets the `aria-checked` state of a menu row. The visible checkmark is a CSS
 *  pseudo-element, so the i18n sweep may replace the label at any time. */
function setMenuRadio(btn, checked) {
  if (btn) btn.setAttribute("aria-checked", String(!!checked));
}

/** Syncs the view menu with the current display order and matching mode, and
 *  highlights the bar button while a non-default state is active (oldest first
 *  or rough matching) – the same signal the old toggle buttons gave. The menu
 *  rows carry their state themselves, so no label in the bar has to follow.
 *  Also the place where the runtime labels of the bar are (re)translated. */
function updateViewMenu() {
  setMenuRadio(els.orderNewestBtn, !oldestFirst);
  setMenuRadio(els.orderOldestBtn, oldestFirst);
  setMenuRadio(els.matchExactBtn, exactMatch);
  setMenuRadio(els.matchRoughBtn, !exactMatch);

  if (els.viewBtn) {
    els.viewBtn.classList.toggle("active", oldestFirst || !exactMatch);
    els.viewBtn.title = ts("history.viewTitle");
  }
  if (els.orderOldestBtn) {
    // Switching to it loads the complete history once and asks beforehand.
    els.orderOldestBtn.title = ts("history.oldestFirstTitle");
  }
  if (els.matchExactBtn) {
    els.matchExactBtn.title = ts("history.matchExactTitle");
  }
  if (els.matchRoughBtn) {
    els.matchRoughBtn.title = ts("history.matchRoughTitle");
  }
  if (els.dataBtn) els.dataBtn.title = ts("history.dataTitle");
}

/** Switches the matching mode between exact (date+time must match) and rough
 *  (is the episode already finished?). Only affects display/selection – the
 *  resolution already delivers both the episode status and the exact-date
 *  match. */
function setExactMatch(on) {
  closeMenus();
  if (exactMatch === !!on) return;
  exactMatch = !!on;
  updateViewMenu();
  // Rows that are now "already recorded" must not stay selected.
  for (const it of allItems) {
    if (isTransferred(it)) it.selected = false;
  }
  render();
}

// The view menu holds both radio groups (order and matching mode).
els.viewBtn.addEventListener("click", () => toggleMenu("viewBtn"));
els.dataBtn.addEventListener("click", () => toggleMenu("dataBtn"));
els.matchExactBtn.addEventListener("click", () => setExactMatch(true));
els.matchRoughBtn.addEventListener("click", () => setExactMatch(false));

// -- Source of the list: service history or an imported file -----------------
// The page can either show the history crawled from the open service tab or an
// imported export file. Both fill the same list; the background decides which
// one a request belongs to (`setSource`).

/** Request for the CURRENT source (service history or the loaded file). */
function loadRequest() {
  if (fileMode && loadedFile) {
    return {
      type: "watcharr:history:loadFile",
      text: loadedFile.text,
      filename: loadedFile.name,
      oldestFirst,
    };
  }
  return {
    type: "watcharr:history:load",
    oldestFirst,
    service: serviceId,
  };
}

/** Sets/clears file mode and keeps the affected controls in sync. */
function setFileMode(on, name) {
  fileMode = !!on;
  fileName = fileMode ? name || fileName || "" : "";
  updateSourceUI();
}

/** Shows/hides the file-mode controls (back button, export availability). */
function updateSourceUI() {
  if (els.backGroup) {
    // "Back" only makes sense for an imported file. It has its own group so
    // that hiding it does not leave an empty slot in the tool strip.
    els.backGroup.classList.toggle("hidden", !fileMode);
  }
  if (els.backBtn) {
    // Short label in the bar, the descriptive text as tooltip.
    els.backBtn.title = ts("history.backToService");
  }
  if (els.fileBtn) {
    // Loading another file stays possible while an imported one is shown.
    els.fileBtn.title = ts("history.loadFileTitle");
  }
  if (els.exportBtn) {
    // Exporting always reads the SERVICE history – in file mode there is
    // nothing to crawl, so the entry is disabled (with an explanation).
    els.exportBtn.disabled = fileMode;
    els.exportBtn.title = fileMode ? ts("history.exportFileMode") : "";
  }
}

/** Reads the chosen file and loads its entries into the list. */
async function loadFile(file) {
  if (!file || loadingInitial || exporting) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    setStatus(
      "error",
      ts("history.fileReadFailed", { error: err.message || String(err) }),
    );
    return;
  }
  const previous = loadedFile;
  loadedFile = { text, name: file.name || "" };
  fileMode = true;
  fileName = file.name || ""; // shown in the header while the file loads
  closeOrderConfirm(); // a pending order dialog belongs to the old list
  updateSourceUI();
  applyServiceHeader();
  const ok = await load();
  if (!ok) {
    // Nothing was imported (unreadable/empty file, no Watcharr, …) – go back to
    // the service list so the page does not stay in a broken file state.
    loadedFile = previous;
    fileMode = false;
    updateSourceUI();
    applyServiceHeader();
  }
}

/** Leaves file mode and shows the service history again. */
async function backToService() {
  if (loadingInitial) return;
  loadedFile = null;
  fileMode = false;
  fileName = "";
  closeOrderConfirm();
  updateSourceUI();
  await applyServiceHeader();
  load();
}

/** Clears the currently shown history so a stale list doesn't linger while a
 * new load runs. Shows `loadingText` as the only list hint; when `showCancel`
 * is set, a button is added to abort the running (long) load. */
function clearList(loadingText, showCancel) {
  items = [];
  allItems = [];
  scrollTriggers = [];
  els.list.innerHTML = "";
  hintEl = null;
  const cancel = showCancel
    ? '<div class="list-action">' +
      '<button type="button" class="ghost cancel-load-btn">' +
      escapeHtml(ts("history.cancelLoad")) +
      "</button></div>"
    : "";
  replaceFromHtml(
    els.list,
    '<div class="list-hint">' +
      escapeHtml(loadingText || "") +
      "</div>" +
      cancel,
  );
  hintEl = els.list.firstChild;
  updateImportButton();
}

async function load() {
  if (loadingInitial || exporting) return false; // a load/export is running
  // Watcharr URL and Jellyfin server decide which host access is required –
  // pick up changes made on the settings page since this page was opened.
  if (!fileMode) await refreshLoadedSettings();
  // Without host access the service tab cannot be read at all, and the remedy
  // needs a click – so say that instead of failing inside the tab.
  if (!fileMode && !(await hasServiceAccess())) {
    await showNeedPermission();
    return false;
  }
  loadingInitial = true; // lock infinite scroll until this load finishes
  const gen = ++loadGen; // supersede any in-flight "load more" / older loads
  clearStatus();
  updateViewMenu();
  const loadingMsg = await t(
    fileMode
      ? "history.loadingFile"
      : oldestFirst
        ? "history.loadingHistoryOldest"
        : "history.loadingHistory",
  );
  setStatus("info", loadingMsg);
  // Remove the previously displayed history; for the long "oldest first"
  // load offer a button to abort it and show the fetch progress.
  clearList(loadingMsg, oldestFirst);
  if (oldestFirst) startProgressPolling("list");
  let ok = false;
  try {
    const resp = await browser.runtime.sendMessage(loadRequest());
    if (gen !== loadGen) return false; // superseded – a newer load owns the state
    if (resp && resp.cancelled) {
      // User aborted the "oldest first" full load -> fall back to the
      // default (newest first) order and load normally again.
      oldestFirst = false;
      updateViewMenu();
      loadingInitial = false; // release the lock so the reload can start
      load();
      return false;
    }
    if (!resp || !resp.ok) {
      throw new Error(await describeError(resp, "history.loadingFailed"));
    }
    ok = true;
    // The background reports the source of the delivered list – this is the
    // single source of truth for file mode (a service load clears it).
    setFileMode(resp.source === "file", resp.file || "");
    allItems = resp.items || [];
    total = resp.total != null ? resp.total : allItems.length;
    allLoaded = !!resp.done;
    render();
    clearStatus();
    if (fileMode) {
      setStatus(
        "success",
        await t("history.fileLoaded", { count: total, file: fileName }),
      );
    } else if (allLoaded) {
      setStatus(
        "success",
        total
          ? await t("history.titlesLoadedAll", { total })
          : await t("history.emptyHistory"),
      );
    } else {
      setStatus("info", await t("history.titlesLoaded", { total }));
    }
  } catch (err) {
    if (gen === loadGen) {
      setStatus("error", err.message);
      replaceFromHtml(
        els.list,
        '<div class="list-hint">' + escapeHtml(err.message) + "</div>",
      );
    }
  } finally {
    // Only the most recent load may release the lock / auto-fill.
    if (gen === loadGen) {
      stopProgressPolling();
      loadingInitial = false; // unlock infinite scroll again
      if (ok) maybeLoadMore();
    }
  }
  return ok;
}

/** Loads the next part of history (infinite scroll, 20-step increments). */
async function loadMore() {
  if (loadingMore || allLoaded || loadingInitial || exporting) return;
  loadingMore = true;
  const gen = loadGen;
  updateHint();
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:more",
      oldestFirst,
      service: serviceId,
    });
    if (!resp || !resp.ok) {
      throw new Error(await describeError(resp, "history.loadingFailed"));
    }
    if (gen !== loadGen) return; // a fresh load replaced this list – discard
    const newItems = resp.items || [];
    allItems.push(...newItems);
    if (resp.total != null) total = resp.total;
    allLoaded = !!resp.done;
    appendItems(newItems);
    if (resp.error) {
      setStatus("error", await describeError(resp, "history.loadingFailed"));
    } else if (allLoaded) {
      clearStatus();
      setStatus("success", await t("history.titlesLoadedAll", { total }));
    } else {
      clearStatus();
      setStatus("info", await t("history.titlesLoaded", { total }));
    }
  } catch (err) {
    if (gen === loadGen) setStatus("error", err.message);
  } finally {
    loadingMore = false;
    // If a fresh load replaced this list, don't touch its UI state/hint.
    if (gen === loadGen) {
      updateHint();
      maybeLoadMore();
    }
  }
}

/** Fills the visible area if there's still space (without scrolling). */
function maybeLoadMore() {
  if (loadingMore || allLoaded || loadingInitial) return;
  const doc = document.documentElement;
  if (doc.scrollHeight <= window.innerHeight + 200) {
    loadMore();
  }
}

// -- Load progress ("oldest first" full load / file export) -----------------
// While the complete history is being fetched, the page polls the background
// once per second and shows how many entries have been fetched by then
// (e.g. "Already 340 entries loaded"). The progress is shown either on the
// list hint of the running load or inside the export dialog.
let progressTimer = null;
let progressActive = false;
let progressMode = "list"; // "list" (history load) | "export" (file export)
const PROGRESS_POLL_MS = 1000;

function stopProgressPolling() {
  progressActive = false;
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

/** Starts the progress polling for a running load ("list") or export. */
function startProgressPolling(mode) {
  stopProgressPolling();
  progressMode = mode === "export" ? "export" : "list";
  progressActive = true;
  progressTimer = setInterval(async () => {
    if (!progressActive) {
      stopProgressPolling();
      return;
    }
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:history:progress",
      });
      if (resp && resp.ok && typeof resp.loaded === "number") {
        updateLoadingProgress(resp.loaded, resp.export);
      }
    } catch (_) {
      /* transient – next tick retries */
    }
  }, PROGRESS_POLL_MS);
}

/** Shows how many entries have been fetched so far (list hint or export dialog).
 *  During an export the `exportInfo` detail distinguishes the two phases:
 *  crawling the service history vs. adding the TMDB data via Watcharr. */
function updateLoadingProgress(loaded, exportInfo) {
  if (progressMode === "export") {
    if (!els.exportProgress) return;
    let text = "";
    if (exportInfo && exportInfo.phase === "match") {
      text = ts("history.exportMatching", {
        done: exportInfo.processed || 0,
        total: exportInfo.total || 0,
      });
    } else if (loaded) {
      text = ts("history.exportProgress", { count: loaded });
    }
    if (!text) return; // keep the generic message until the first page
    els.exportProgress.textContent = text;
    els.exportProgress.classList.remove("hidden");
    return;
  }
  if (!loaded) return; // keep the generic loading message until the first page
  const h = els.list.querySelector(".list-hint");
  if (h) h.textContent = ts("history.loadedSoFar", { count: loaded });
}

// -- Cancel a running ("oldest first") load ------------------------------
// Aborts the long full-history load in the background. The still-pending
// load() response then arrives with `cancelled: true` and automatically
// falls back to the default (newest first) order.
async function cancelLoad() {
  if (!loadingInitial || !oldestFirst) return;
  const btn = els.list.querySelector(".cancel-load-btn");
  if (btn) btn.disabled = true; // avoid duplicate clicks
  try {
    await browser.runtime.sendMessage({ type: "watcharr:history:cancel" });
  } catch (_) {
    /* ignore – the running load may already have finished */
  }
}

// Cancel button inside the loading placeholder (event delegation).
els.list.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".cancel-load-btn");
  if (btn) cancelLoad();
});

// -- Sort order (oldest first / newest first) --------------------------------
// Switching to "oldest first" loads the complete history once -> ask first.
function openOrderConfirm() {
  els.confirmModal.classList.remove("hidden");
  els.orderOkBtn.focus();
}

function closeOrderConfirm() {
  els.confirmModal.classList.add("hidden");
}

els.orderNewestBtn.addEventListener("click", () => {
  closeMenus();
  if (loadingInitial || !oldestFirst) return; // already newest first
  oldestFirst = false; // back to newest first is instant – no confirmation
  updateViewMenu();
  load();
});

els.orderOldestBtn.addEventListener("click", () => {
  closeMenus();
  if (loadingInitial || oldestFirst) return; // already oldest first
  openOrderConfirm(); // switching to oldest first needs confirmation
});

els.orderOkBtn.addEventListener("click", () => {
  closeOrderConfirm();
  oldestFirst = true;
  updateViewMenu();
  load(); // reloads the list in the new order
});

els.orderCancelBtn.addEventListener("click", closeOrderConfirm);

// Click on the backdrop closes the dialog; Esc works as well.
els.confirmModal.addEventListener("click", (e) => {
  if (e.target === els.confirmModal) closeOrderConfirm();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (anyMenuOpen()) {
    closeMenus();
  } else if (!els.confirmModal.classList.contains("hidden")) {
    closeOrderConfirm();
  } else if (!exporting && !els.exportModal.classList.contains("hidden")) {
    // Esc does not close the export dialog while the crawl is running.
    closeExportDialog();
  }
});

// -- Selection / Filter ---------------------------------------------------------
els.selectAllBtn.addEventListener("click", () => {
  for (const it of allItems) it.selected = !isTransferred(it);
  render();
});
els.selectNoneBtn.addEventListener("click", () => {
  for (const it of allItems) it.selected = false;
  render();
});

els.filterBox.addEventListener("input", () => {
  filter = els.filterBox.value.trim().toLowerCase();
  render();
});

// Checkbox changes (event delegation)
els.list.addEventListener("change", (e) => {
  if (e.target && e.target.classList.contains("sel")) {
    const row = e.target.closest(".row");
    const it = allItems.find((x) => x.key === row.dataset.key);
    if (it) it.selected = e.target.checked;
    updateImportButton();
  }
});

// -- Change match (popover with Watcharr search) --------------------------------
let searchTimer = null;

els.list.addEventListener("click", async (e) => {
  const btn = e.target.closest(".rematch-btn");
  if (!btn) return;
  const row = btn.closest(".row");
  const key = row.dataset.key;
  const it = allItems.find((x) => x.key === key);
  const existing = document.querySelector(
    '.rematch-panel[data-key="' + escapeHtml(key) + '"]',
  );
  if (existing) {
    existing.remove();
    return;
  }
  // Episode rows: season/episode are editable, because a wrong episode number
  // must be correctable even when the series match itself is right.
  const isEpisode = !!(
    it &&
    it.isTv &&
    it.season != null &&
    it.episode != null
  );
  const episodeFields = isEpisode
    ? '<div class="rematch-episode">' +
      "<label><span>" +
      escapeHtml(ts("history.episodeSeason")) +
      '</span><input type="number" class="ep-season" min="0" step="1" ' +
      'inputmode="numeric" value="' +
      it.season +
      '" /></label>' +
      "<label><span>" +
      escapeHtml(ts("history.episodeNumber")) +
      '</span><input type="number" class="ep-episode" min="1" step="1" ' +
      'inputmode="numeric" value="' +
      it.episode +
      '" /></label>' +
      '<button type="button" class="ghost apply-episode">' +
      escapeHtml(ts("history.episodeApply")) +
      "</button>" +
      "</div>"
    : "";
  // Insert panel
  const panel = document.createElement("div");
  panel.className = "rematch-panel";
  panel.dataset.key = key;
  replaceFromHtml(
    panel,
    episodeFields +
      '<input type="search" class="rematch-search" placeholder="' +
      escapeHtml(ts("history.searchTitle")) +
      '" autocomplete="off" />' +
      '<div class="hint">' +
      escapeHtml(ts("history.searchHint")) +
      "</div>" +
      '<div class="rematch-results"></div>',
  );
  row.after(panel);

  // Season/episode as currently typed into the (editable) number fields.
  const readEpisode = () => {
    if (!isEpisode) return null;
    const season = parseInt(panel.querySelector(".ep-season").value, 10);
    const number = parseInt(panel.querySelector(".ep-episode").value, 10);
    return {
      season: Number.isInteger(season) && season >= 0 ? season : it.season,
      episode: Number.isInteger(number) && number >= 1 ? number : it.episode,
    };
  };
  const applyEpisodeBtn = panel.querySelector(".apply-episode");
  if (applyEpisodeBtn) {
    // "Apply" corrects season/episode without touching the series match.
    applyEpisodeBtn.addEventListener("click", () => {
      rematch(key, null, readEpisode());
    });
  }

  const input = panel.querySelector(".rematch-search");
  input.focus();

  const runSearch = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const resultsBox = panel.querySelector(".rematch-results");
    replaceFromHtml(
      resultsBox,
      '<div class="hint">' + escapeHtml(ts("history.searching")) + "</div>",
    );
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:search",
        query: q,
        searchType: "multi",
      });
      const results =
        resp && resp.ok ? (resp.data && resp.data.results) || [] : [];
      if (!results.length) {
        replaceFromHtml(
          resultsBox,
          '<div class="hint">' + escapeHtml(ts("history.noResults")) + "</div>",
        );
        return;
      }
      resultsBox.innerHTML = "";
      for (const r of results.slice(0, 12)) {
        const item = document.createElement("div");
        item.className = "rematch-result";
        const poster = r.extPosterPath ? TMDB_IMG + r.extPosterPath : null;
        const url = tmdbUrl(r);
        replaceFromHtml(
          item,
          (poster
            ? '<img class="poster" src="' + escapeHtml(poster) + '" alt="" />'
            : '<div class="poster ph"></div>') +
            '<div class="info"><div class="name">' +
            escapeHtml(r.name || "") +
            "</div>" +
            '<div class="meta">' +
            escapeHtml(
              searchTypeLabel((r.type || "").replace("tmdb_", "")) +
                (r.releaseDate
                  ? " · " + String(r.releaseDate).slice(0, 4)
                  : ""),
            ) +
            "</div></div>" +
            // Opens the TMDB page of this result in a new tab (independent of
            // picking it as the match).
            (url
              ? '<a class="tmdb-link" href="' +
                escapeHtml(url) +
                '" target="_blank" rel="noopener noreferrer" title="' +
                escapeHtml(ts("history.openTmdb")) +
                '">TMDB</a>'
              : ""),
        );
        item.addEventListener("click", () => {
          rematch(key, r, readEpisode());
          panel.remove();
        });
        // The link must not pick the entry as the new match.
        const link = item.querySelector(".tmdb-link");
        if (link) link.addEventListener("click", (ev) => ev.stopPropagation());
        resultsBox.appendChild(item);
      }
    } catch (err) {
      replaceFromHtml(
        resultsBox,
        '<div class="hint">' +
          escapeHtml(ts("history.searchFailed", { error: err.message })) +
          "</div>",
      );
    }
  };

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch();
    }
  });
});

/** Applies a new match (`result`, a TMDB search hit) and/or a corrected
 *  season/episode (`episode`) to one history row. */
async function rematch(key, result, episode) {
  const resp = await browser.runtime.sendMessage({
    type: "watcharr:history:rematch",
    key,
    result,
    season: episode ? episode.season : null,
    episode: episode ? episode.episode : null,
  });
  if (resp && resp.ok && resp.item) {
    const it = allItems.find((x) => x.key === key);
    if (it) {
      Object.assign(it, resp.item);
      if (isTransferred(it)) it.selected = false;
    }
    render();
    if (result) {
      setStatus(
        "success",
        ts("history.matchUpdated", { title: resp.item.title || key }),
      );
    } else {
      // Episode-only correction (season/episode), match unchanged.
      setStatus(
        "success",
        ts("history.episodeUpdated", {
          season: resp.item.season,
          episode: resp.item.episode,
        }),
      );
    }
  } else {
    const msg = resp
      ? await describeError(resp, "history.matchCouldNotBeUpdated")
      : ts("history.matchCouldNotBeUpdated");
    setStatus("error", msg);
  }
}

/** Summarizes an import result for the status line. */
function importSummary(results) {
  const st = {
    imported: ts("history.statusImported"),
    updated: ts("history.statusUpdated"),
    skipped: ts("history.statusSkipped"),
    error: ts("history.statusError"),
  };
  const parts = [];
  for (const s of ["imported", "updated", "skipped", "error"]) {
    const n = results.filter((r) => r.status === s).length;
    if (n) parts.push(n + " " + st[s]);
  }
  return parts.length ? parts.join(" · ") : ts("history.nothingToDo");
}

// -- Import -------------------------------------------------------------------
els.importBtn.addEventListener("click", async () => {
  const keys = allItems.filter((it) => it.selected).map((it) => it.key);
  if (!keys.length) return;
  els.importBtn.disabled = true;
  els.importBtn.textContent = ts("history.importing");
  setStatus("info", await t("history.importingTitles", { count: keys.length }));
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:import",
      keys,
    });
    if (!resp || !resp.ok)
      throw new Error(await describeError(resp, "history.loadingFailed"));
    const results = resp.results || [];
    const byKey = {};
    for (const r of results) byKey[r.key] = r;
    for (const it of allItems) {
      if (byKey[it.key]) {
        it.status = byKey[it.key].status;
        it.error = byKey[it.key].error || null;
        it.errorCode = byKey[it.key].code || null;
        if (it.status === "imported" || it.status === "updated") {
          it.selected = false;
          if (it.match) it.match.watchedId = byKey[it.key].watchedId || true;
        }
      }
    }
    render();
    const okCount = results.filter(
      (r) => r.status === "imported" || r.status === "updated",
    ).length;
    const errCount = results.filter((r) => r.status === "error").length;
    if (okCount > 0) {
      showStatusPopup(
        "success",
        await t("history.importCompleted", { summary: importSummary(results) }),
      );
    } else if (errCount > 0) {
      showStatusPopup(
        "error",
        await t("history.importFailed", { summary: importSummary(results) }),
      );
    } else {
      showStatusPopup(
        "info",
        await t("history.importCompleted", { summary: importSummary(results) }),
      );
    }
  } catch (err) {
    setStatus("error", err.message);
  } finally {
    els.importBtn.disabled = false;
    updateImportButton();
  }
});

// -- Export of the complete history into a file -------------------------------
// Like "oldest first", the export fetches the COMPLETE history of the current
// service and writes it into a CSV or JSON file – nothing is imported into
// Watcharr. Optionally every entry is resolved against TMDB through the
// Watcharr instance; those TMDB columns make the file importable by other
// services. The dialog stays open while the export runs, shows progress and
// offers an abort button.
//
// Row shape and file serialization live in
// content/history-file/export.js (`WatcharrHistoryFileExport`); this page only
// picks the format, downloads the text and shows progress.

/** File name of the export, e.g. "watcharr-scrobbler-netflix-2026-09-16.csv". */
function exportFilename(format) {
  return WatcharrHistoryFileExport.filename(serviceId, format);
}

/** Chosen export format ("csv" | "json") from the dialog. */
function selectedExportFormat() {
  const checked = document.querySelector('input[name="exportFormat"]:checked');
  return checked && checked.value === "json" ? "json" : "csv";
}

/** CSV text of the export rows (RFC 4180, see content/history-file/export.js). */
function rowsToCsv(rows) {
  return WatcharrHistoryFileExport.toCsv(rows);
}

/** JSON text of the export rows, with the metadata header of this export. */
function rowsToJson(rows) {
  const svc = WatcharrServices.byId(serviceId);
  return WatcharrHistoryFileExport.toJson(rows, svc ? svc.name : serviceId);
}

/** Triggers the download of a generated text file (blob URL, no permission). */
function downloadTextFile(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** The TMDB enrichment can only run with a configured Watcharr connection:
 *  the TMDB search is proxied by the Watcharr instance. Keeps the checkbox in
 *  sync with the connection state when the dialog is opened. */
async function syncExportEnrichOption() {
  if (!els.exportEnrich) return;
  let configured = false;
  try {
    const state = await browser.runtime.sendMessage({
      type: "watcharr:getState",
    });
    configured = !!(
      state &&
      state.ok &&
      state.settings &&
      state.settings.configured
    );
  } catch (_) {
    /* no answer – keep the option disabled and explain why */
  }
  els.exportEnrich.disabled = !configured;
  if (!configured) els.exportEnrich.checked = false;
  if (els.exportEnrichHint) {
    els.exportEnrichHint.textContent = ts(
      configured ? "history.exportEnrichHint" : "history.exportNoWatcharr",
    );
  }
}

function openExportDialog() {
  // One crawl at a time; an imported file is not a service history.
  if (loadingInitial || exporting || fileMode) return;
  els.exportProgress.classList.add("hidden");
  els.exportProgress.textContent = "";
  els.exportOkBtn.disabled = false;
  els.exportOkBtn.textContent = ts("history.exportStart");
  els.exportCancelBtn.disabled = false;
  els.exportCancelBtn.textContent = ts("history.cancel");
  els.exportModal.classList.remove("hidden");
  syncExportEnrichOption(); // async – the dialog is usable meanwhile
  els.exportOkBtn.focus();
}

function closeExportDialog() {
  els.exportModal.classList.add("hidden");
}

/** Fetches the complete history in the background and writes it to a file. */
async function runExport() {
  if (exporting || fileMode) return;
  exporting = true;
  const format = selectedExportFormat();
  const enrich = !!(els.exportEnrich && els.exportEnrich.checked);
  const svc = WatcharrServices.byId(serviceId);
  // Keep the dialog open as a progress display (with abort) while crawling.
  els.exportOkBtn.disabled = true;
  els.exportProgress.classList.remove("hidden");
  els.exportProgress.textContent = ts("history.exportRunning", {
    service: svc ? svc.name : "",
  });
  els.exportCancelBtn.textContent = ts("history.exportAbort");
  startProgressPolling("export");
  const file = exportFilename(format);
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:export",
      service: serviceId,
      enrich,
    });
    if (resp && resp.cancelled) {
      showStatusPopup(
        "info",
        await t("history.exportCancelled", {
          count: (resp.rows || []).length,
        }),
      );
      return;
    }
    if (!resp || !resp.ok) {
      throw new Error(await describeError(resp, "history.exportFailed"));
    }
    const rows = resp.rows || [];
    if (!rows.length) {
      setStatus("info", await t("history.emptyHistory"));
      return;
    }
    if (format === "json") {
      downloadTextFile(file, rowsToJson(rows), "application/json");
    } else {
      // BOM so Excel detects UTF-8 (umlauts/accents in titles).
      downloadTextFile(
        file,
        "\uFEFF" + rowsToCsv(rows),
        "text/csv;charset=utf-8",
      );
    }
    // The safety cap of the crawl may have cut the history short – say so
    // instead of pretending that everything was exported.
    if (resp.truncated) {
      showStatusPopup(
        "info",
        await t("history.exportTruncated", { count: rows.length }),
      );
    } else if (resp.enriched) {
      // Report how many rows actually carry TMDB data – the rest can only be
      // matched by title/year at the target service.
      const matched = resp.matched || rows.filter((r) => r.tmdbId).length;
      showStatusPopup(
        "success",
        await t("history.exportDoneEnriched", {
          count: rows.length,
          matched,
          unmatched: rows.length - matched,
        }),
      );
    } else {
      showStatusPopup(
        "success",
        await t("history.exportDone", { count: rows.length }),
      );
    }
  } catch (err) {
    setStatus("error", err.message);
  } finally {
    stopProgressPolling();
    exporting = false;
    closeExportDialog();
  }
}

els.exportBtn.addEventListener("click", () => {
  closeMenus();
  openExportDialog();
});
els.exportOkBtn.addEventListener("click", runExport);
els.exportCancelBtn.addEventListener("click", async () => {
  if (!exporting) {
    closeExportDialog();
    return;
  }
  // Abort the crawl – the pending response then comes back as "cancelled".
  els.exportCancelBtn.disabled = true;
  els.exportProgress.textContent = ts("history.exportAborting");
  try {
    await browser.runtime.sendMessage({ type: "watcharr:history:cancel" });
  } catch (_) {
    /* the crawl may already have finished */
  }
});
// Click on the backdrop closes the dialog (not while an export is running).
els.exportModal.addEventListener("click", (e) => {
  if (e.target === els.exportModal && !exporting) closeExportDialog();
});

els.reloadBtn.addEventListener("click", async () => {
  // Missing host access is the one load failure the user can fix with a click –
  // granting a permission needs a user gesture, and this click is one. The
  // request starts synchronously inside requestServiceAccess; when everything is
  // already granted it resolves without a prompt.
  await requestServiceAccess();
  if (!(await hasServiceAccess())) {
    await showPermissionBlocked();
    return;
  }
  load();
});

// -- Import from a file -------------------------------------------------------
// Fills the list from a previously exported history file (CSV/JSON) instead of
// the open service tab; the rows are then matched and imported as usual.
els.fileBtn.addEventListener("click", () => {
  closeMenus();
  if (loadingInitial || exporting) return; // one load at a time
  els.fileInput.click();
});

els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  // Let the same file be picked again later (change event would not fire).
  els.fileInput.value = "";
  if (file) await loadFile(file);
});

els.backBtn.addEventListener("click", backToService);

// Infinite Scroll: load more as soon as only PREFETCH_THRESHOLD rows are
// left until the bottom of the viewport.
window.addEventListener("scroll", () => {
  if (loadingMore || allLoaded || loadingInitial) return;
  if (!scrollTriggers.length) return;
  const rect = scrollTriggers[0].getBoundingClientRect();
  if (rect.top <= window.innerHeight) {
    loadMore();
  }
});

/** Sets the header title/subtitle to the selected service (or to the loaded
 *  file while the page is in file-import mode). */
async function applyServiceHeader() {
  if (fileMode) {
    if (els.pageTitle) els.pageTitle.textContent = await t("history.fileTitle");
    if (els.pageSubtitle) {
      els.pageSubtitle.textContent = await t("history.fileSubtitle", {
        file: fileName || "—",
      });
    }
    return;
  }
  const svc = WatcharrServices.byId(serviceId);
  const name = svc ? svc.name : "";
  if (els.pageTitle)
    els.pageTitle.textContent = await t("history.pageTitle", {
      service: name,
    });
  if (els.pageSubtitle)
    els.pageSubtitle.textContent = await t("history.pageSubtitle", {
      service: name,
    });
}

/**
 * The service the switch button would jump to, or null when there is nothing
 * to switch to. With two open services it is simply the other one; with three
 * or more it walks through the open services in order and starts over at the
 * end, so repeated clicks cycle through all of them.
 */
function nextService() {
  if (availableServices.length < 2) return null;
  const idx = availableServices.findIndex((s) => s.id === serviceId);
  // The displayed service is not (or no longer) among the open ones – start
  // the cycle at the beginning.
  if (idx < 0) return availableServices[0] || null;
  return availableServices[(idx + 1) % availableServices.length];
}

/**
 * Renders the provider switch in the header: it shows which service's history
 * is displayed – nothing else. The switch symbol comes from the stylesheet
 * (`.service-btn::after`) and only appears while a second service has an open
 * tab; the tooltip names the service the click would lead to. Naming only the
 * current service keeps the button narrow for any number of open services.
 */
function renderServiceToggle(available) {
  availableServices = available || [];
  const btn = els.serviceBtn;
  if (!btn) return;
  const svc = WatcharrServices.byId(serviceId);
  // In file-import mode there is no service to switch to – the provider
  // button would only be confusing ("Back to service history" does that).
  if (fileMode || !svc || !serviceAvailable || availableServices.length === 0) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const target = nextService();
  // Rebuild the label only when it really changed – the reconciliation runs a
  // few times per second, and rewriting the DOM on every run would flicker.
  if (btn.dataset.label !== svc.name) {
    btn.dataset.label = svc.name;
    btn.textContent = svc.name;
  }
  btn.classList.toggle("toggleable", !!target);
  btn.title = target
    ? ts("history.switchProviderTitle", {
        service: svc.name,
        target: target.name,
      })
    : ts("history.pageTitle", { service: svc.name });
}

/** Open services of a background watcher snapshot / message payload. */
function servicesFromSnapshot(snap) {
  return (snap && Array.isArray(snap.services) ? snap.services : [])
    .filter((s) => s && s.open)
    .map((s) => WatcharrServices.byId(s.id))
    .filter(Boolean);
}

/** The service in front, when it is one of `available`, else the first one. */
function pickChosen(available, activeServiceId) {
  const preferred = activeServiceId
    ? WatcharrServices.byId(activeServiceId)
    : null;
  return preferred && available.some((s) => s.id === preferred.id)
    ? preferred
    : available[0] || null;
}

/** Turns a watchdog payload/snapshot into the shape used by refreshProviders. */
function detectionFromSnapshot(snap) {
  const available = servicesFromSnapshot(snap);
  const activeServiceId = (snap && snap.activeServiceId) || null;
  return {
    available,
    activeServiceId,
    chosen: pickChosen(available, activeServiceId),
    revision: snap && typeof snap.revision === "number" ? snap.revision : null,
  };
}

/**
 * Asks the background's tab watcher which services have an open tab and which
 * one is in front. It is event-driven, so a freshly opened/closed service tab
 * is known immediately, and it is the SAME state the popup uses.
 * Returns null when the background cannot be reached.
 */
async function serviceTabsFromBackground() {
  try {
    const snap = await browser.runtime.sendMessage({
      type: "watcharr:serviceTabs:refresh",
    });
    if (!snap || !snap.ok || !Array.isArray(snap.services)) {
      dbg("background: unusable answer", snap);
      return null;
    }
    dbg("background:", {
      open: snap.openServiceIds,
      active: snap.activeServiceId,
      revision: snap.revision,
    });
    return detectionFromSnapshot(snap);
  } catch (err) {
    // Background unreachable -> the caller combines with the local detection.
    dbg("background: unreachable", err && err.message);
    return null;
  }
}

/**
 * Local detection: lists ALL tabs once and matches them with the service
 * registry's own URL logic (`WatcharrServices.byUrl`).
 *
 * Deliberately NOT `tabs.query({ url: svc.urlPattern })`: the browser's
 * match-pattern engine and the registry's matching do not always agree, and the
 * Jellyfin base path cannot be expressed as a pattern. One listing is also
 * cheaper. The per-service pattern queries remain as a fallback for the case
 * that the full listing is not available.
 */
async function detectServicesLocally() {
  const wanted = WatcharrServices.list.filter((s) =>
    WatcharrServices.hasHistory(s),
  );
  const available = [];
  let allTabs = [];
  try {
    allTabs = (await browser.tabs.query({})) || [];
    if (DEBUG) {
      const readable = allTabs.filter((t) => t && t.url);
      const hosts = readable.map((t) => {
        try {
          return new URL(t.url).hostname + (t.active ? "*" : "");
        } catch (_) {
          return "?";
        }
      });
      dbg(
        "tabs:",
        allTabs.length + " total,",
        allTabs.length - readable.length + " without readable url ->",
        hosts.join(", ") || "(none)",
      );
    }
  } catch (err) {
    dbg("listing all tabs failed", err && err.message);
  }

  for (const svc of wanted) {
    // Two independent lookups, because they fail for different reasons:
    //  - matching the tab URLs here needs the tab URL to be READABLE (without
    //    the "tabs" permission a browser hides it for foreign tabs),
    //  - the pattern query is matched by the browser itself and therefore also
    //    finds tabs whose URL this page cannot see.
    let found = allTabs.filter(
      (t) => t && t.url && WatcharrServices.byUrl(t.url) === svc,
    ).length;
    if (!found) {
      try {
        const tabs = await browser.tabs.query({ url: svc.urlPattern });
        found = (tabs || []).filter((t) => t.id != null).length;
      } catch (err) {
        dbg("pattern query failed", svc.id, svc.urlPattern, err && err.message);
      }
    }
    dbg("local detect", svc.id, "->", found, "tab(s)");
    if (found) available.push(svc);
  }

  let activeServiceId = null;
  for (const query of [
    { active: true, lastFocusedWindow: true },
    { active: true },
  ]) {
    try {
      const active = (await browser.tabs.query(query))[0];
      const activeSvc =
        active && active.url ? WatcharrServices.byUrl(active.url) : null;
      if (activeSvc) {
        activeServiceId = activeSvc.id;
        break;
      }
    } catch (_) {
      /* try the next query variant */
    }
  }
  return {
    available,
    activeServiceId,
    chosen: pickChosen(available, activeServiceId),
  };
}

/**
 * Which services have an open, usable tab, and which one should be displayed:
 * the service in front wins, otherwise the first one with an open tab.
 *
 * Both sources are UNIONED, not ranked: a stale answer must never hide an open
 * service. The background snapshot is built on a debounce and a service tab
 * that is still loading may not have its URL yet, so the direct query from here
 * closes that gap and makes a freshly opened tab show up right away.
 */
async function detectServices() {
  const [fromBackground, local] = await Promise.all([
    serviceTabsFromBackground(),
    detectServicesLocally(),
  ]);
  const openIds = new Set();
  if (fromBackground)
    fromBackground.available.forEach((s) => openIds.add(s.id));
  local.available.forEach((s) => openIds.add(s.id));
  // Registry order (netflix, primevideo, jellyfin) keeps the button's cycle
  // order stable, no matter which source found what.
  const available = WatcharrServices.list.filter(
    (s) => openIds.has(s.id) && WatcharrServices.hasHistory(s),
  );
  // For the service in front the background wins: it also sees focus changes
  // (window switches) that this page cannot observe as reliably.
  const activeServiceId =
    (fromBackground && fromBackground.activeServiceId) ||
    local.activeServiceId ||
    null;
  dbg("detected:", {
    background: fromBackground
      ? fromBackground.available.map((s) => s.id)
      : null,
    local: local.available.map((s) => s.id),
    merged: available.map((s) => s.id),
    activeServiceId,
  });
  return {
    available,
    activeServiceId,
    chosen: pickChosen(available, activeServiceId),
  };
}

/** No service tab is open – the history cannot be loaded. */
async function showNoService() {
  const names = WatcharrServices.list
    .filter((s) => WatcharrServices.hasHistory(s))
    .map((s) => s.name)
    .join(" / ");
  const msg = await t("history.noServiceTab", { services: names });
  setStatus("error", msg);
  replaceFromHtml(
    els.list,
    '<div class="list-hint">' + escapeHtml(msg) + "</div>",
  );
  updateImportButton();
}

/**
 * Host access the background needs to load the history of the CURRENT service:
 * the patterns of that one service and the user's Watcharr instance – see
 * WatcharrServices.permissionOrigins.
 *
 * Only the current service is asked for: the browser grants all requested
 * permissions or none, so a single foreign origin would block the whole
 * request. The Watcharr URL is known at runtime only and is therefore requested
 * when the need arises (see requestServiceAccess).
 */
function neededOrigins() {
  return originsForService(serviceId);
}

/** Match patterns that have to be granted for ONE service: its hosts plus the
 *  Watcharr instance. */
function originsForService(id) {
  return WatcharrServices.permissionOrigins(loadedSettings || {}, [id]);
}

/** Display name of a service (default: the one whose history is shown here).
 *  Used so permission messages name the concrete service instead of a list. */
function serviceLabel(id) {
  const svc = WatcharrServices.byId(id || serviceId);
  return svc ? svc.name : "";
}

/** Services from `list` whose host access is not granted yet. Returns [] when
 *  the Permissions API is unavailable or the check fails – never throws. */
async function servicesWithoutAccess(list) {
  const out = [];
  if (!browser.permissions || !browser.permissions.contains) return out;
  for (const svc of list) {
    const origins = originsForService(svc.id);
    if (!origins.length) continue;
    try {
      if (!(await browser.permissions.contains({ origins }))) out.push(svc);
    } catch (_) {
      /* cannot check – do not claim the access is missing */
    }
  }
  return out;
}

/** Name for a permission message: the service this page is about, i.e. the one
 *  whose history it loads and whose hosts the next "Reload" click asks for.
 *  When that service already has access (a blocked host is the reason then),
 *  the check names whoever really is missing it – and if the check cannot
 *  decide, the service itself is named instead of listing all known ones. */
async function missingAccessServiceNames() {
  const svc = WatcharrServices.byId(serviceId);
  const candidates = svc ? [svc] : availableServices.slice();
  const missing = await servicesWithoutAccess(candidates);
  const list = missing.length ? missing : candidates;
  if (list.length) return list.map((s) => s.name).join(" / ");
  return WatcharrServices.list
    .filter((s) => WatcharrServices.hasHistory(s))
    .map((s) => s.name)
    .join(" / ");
}

/** Refreshes the settings this page works with (Watcharr URL, Jellyfin server).
 *  Both decide which host access is checked and requested, and both can have
 *  been changed on the settings page since this page was opened. Never throws. */
async function refreshLoadedSettings() {
  try {
    const state = await browser.runtime.sendMessage({
      type: "watcharr:getState",
    });
    if (state && state.ok && state.settings) {
      loadedSettings = state.settings;
      if (window.WatcharrServices)
        WatcharrServices.applySettings(state.settings);
    }
  } catch (_) {
    /* keep the settings this page was opened with */
  }
  return loadedSettings;
}

/** True when the extension may read (and inject into) the service pages and
 *  reach the service API / Watcharr. Host permissions are optional in Firefox –
 *  the manifest only *requests* them, so they can be missing even after a
 *  successful install. */
async function hasServiceAccess() {
  if (!browser.permissions || !browser.permissions.contains) return true;
  try {
    return await browser.permissions.contains({ origins: neededOrigins() });
  } catch (_) {
    return true; // cannot check – let the load report the real problem
  }
}

/** Asks for the missing host access (Reload button, settings page).
 *
 *  Nothing is shown when the access is already granted; resolves true when the
 *  access is (now) granted – also when the API is missing entirely.
 *
 *  MUST be started from the click handler itself: a runtime permission request
 *  is only honoured while the triggering user action is still being handled.
 *  Every `await` before it ends that task, and Firefox then drops the request
 *  without a prompt or error. The origins are therefore computed synchronously
 *  and permissions.request is the first call made here. */
function requestServiceAccess() {
  if (!browser.permissions || !browser.permissions.request) {
    return Promise.resolve(true); // no Permissions API – just load
  }
  const origins = neededOrigins();
  if (!origins.length) return Promise.resolve(true);
  let request;
  try {
    // No await above this line: the user gesture has to still be active.
    request = browser.permissions.request({ origins });
  } catch (err) {
    dbg("permission request threw", err && err.message);
    return Promise.resolve(false);
  }
  return Promise.resolve(request).then(
    (granted) => {
      dbg("permission request ->", granted, origins);
      return !!granted;
    },
    (err) => {
      dbg("permission request failed", err && err.message);
      return false;
    },
  );
}

/** The browser did not grant the host access – the request was refused, or it
 *  was not accepted as a user action at all. Say how to grant it by hand
 *  instead of leaving the user with a button that seems to do nothing. */
async function showPermissionBlocked() {
  await showPermissionHint("history.permissionBlocked");
}

/** The extension is not allowed to read the service yet. Says so instead of
 *  letting the load end in a tab error the user cannot act on. */
async function showNeedPermission() {
  await showPermissionHint("history.needPermission");
}

/** Shows one of the "no host access" hints in the status bar and the list, both
 *  naming the concrete service the missing access belongs to. */
async function showPermissionHint(key) {
  const service = await missingAccessServiceNames();
  const msg = await t(key, { service });
  setStatus("error", msg);
  replaceFromHtml(
    els.list,
    '<div class="list-hint">' + escapeHtml(msg) + "</div>",
  );
  updateImportButton();
}

/** Switches the history provider and reloads it (used by the toggle button). */
async function switchProvider(id) {
  serviceId = id;
  serviceAvailable = true;
  // Leaving file mode: the provider button always loads service history.
  loadedFile = null;
  fileMode = false;
  updateSourceUI();
  applyServiceHeader();
  renderServiceToggle(availableServices);
  // A different service = a completely different history.
  oldestFirst = false;
  updateViewMenu();
  load();
}

/**
 * Re-checks which service tabs are open and reconciles the header switch:
 *  - no service tab open                  -> switch hidden (current list kept),
 *  - current provider's tab gone, another open -> switch to it (and reload),
 *  - first provider appeared while open   -> load its history,
 *  - service in front changed             -> follow it (and reload),
 *  - otherwise                            -> only refresh the switch state.
 * Returns true when a history load was started.
 */
async function refreshProviders(detection, reason) {
  const { available, chosen, activeServiceId } =
    detection || (await detectServices());
  availableServices = available;

  // File-import mode: tab events must not replace the imported list.
  if (fileMode) {
    renderServiceToggle(available);
    return false;
  }

  if (!chosen) {
    // No service tab is open (any more). Hide the switch, but keep the current
    // view so closing a tab does not wipe the loaded history.
    serviceAvailable = false;
    renderServiceToggle(available);
    return false;
  }

  const currentOpen = available.some((s) => s.id === serviceId);
  // Only a service that REALLY is in front (a service tab the user is looking
  // at) makes the page follow. `chosen` must not be used for this: without a
  // service tab in front it falls back to the FIRST open service, so a
  // deliberate switch via the header button would be undone a moment later by
  // the next reconciliation.
  const focusedChanged =
    !!activeServiceId &&
    activeServiceId !== serviceId &&
    available.some((s) => s.id === activeServiceId);
  dbg("reconcile (" + (reason || "unspecified") + "):", {
    available: available.map((s) => s.id),
    chosen: chosen ? chosen.id : null,
    activeServiceId,
    serviceId,
    serviceAvailable,
    currentOpen,
    focusedChanged,
  });
  if (!serviceAvailable || !currentOpen || focusedChanged) {
    // First detection, the current provider's tab was closed, or the service
    // in front changed. A second provider that is merely opened in the
    // background does NOT switch the view – the header button turns into a
    // switch instead (see renderServiceToggle).
    serviceId = chosen.id;
    serviceAvailable = true;
    await applyServiceHeader();
    renderServiceToggle(available);
    if (loadingInitial) return false; // a load is running – it owns the list
    // A different service = a completely different history.
    oldestFirst = false;
    updateViewMenu();
    load();
    return true;
  }

  // Provider unchanged – just keep the switch in sync with the open tabs.
  renderServiceToggle(available);
  return false;
}

let providerRefreshTimer = null;

/** Debounced provider re-check – bursts of tab events trigger one run. */
function scheduleProviderRefresh() {
  if (providerRefreshTimer) clearTimeout(providerRefreshTimer);
  providerRefreshTimer = setTimeout(() => {
    providerRefreshTimer = null;
    refreshProviders(undefined, "tab-event");
  }, 400);
}

/**
 * Keeps the header switch in sync with the open service tabs, via two paths:
 *   1. the background watcher broadcasts every change
 *      (`watcharr:serviceTabs:changed`) with the new state in the payload, so it
 *      is applied directly (one round trip less, no lost update in between),
 *   2. the local tab events below are the fallback for the (rare) case that the
 *      background is restarted and the broadcast never arrives.
 */
function bindTabEvents() {
  try {
    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "watcharr:serviceTabs:changed") return;
      dbg("event: background broadcast", msg.openServiceIds);
      // The background already debounced the event burst – reconcile now.
      refreshProviders(detectionFromSnapshot(msg), "broadcast");
    });
  } catch (_) {
    /* runtime messages not available in this context */
  }
  const onEvent = (name) => () => {
    dbg("event:", name);
    scheduleProviderRefresh();
  };
  try {
    browser.tabs.onCreated.addListener(onEvent("tabs.onCreated"));
    browser.tabs.onRemoved.addListener(onEvent("tabs.onRemoved"));
    browser.tabs.onActivated.addListener(onEvent("tabs.onActivated"));
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      // React when a tab finished loading or its URL changed; plain loading
      // status updates would be too noisy.
      if (changeInfo && (changeInfo.url || changeInfo.status === "complete")) {
        dbg("event: tabs.onUpdated", changeInfo.status || changeInfo.url);
        scheduleProviderRefresh();
      }
    });
    dbg("listening for tab events");
  } catch (err) {
    // Tab events not available in this context – only the periodic
    // reconciliation below would be left, which is worth reporting.
    dbg("tab events unavailable", err && err.message);
  }
}

async function initHistory() {
  // The Jellyfin server URL is part of the settings and defines the service's
  // tab pattern – load it before any service detection runs (the same settings
  // say which host access has to be requested, see neededOrigins).
  try {
    const state = await browser.runtime.sendMessage({
      type: "watcharr:getState",
    });
    if (state && state.ok && window.WatcharrServices) {
      loadedSettings = state.settings || null;
      WatcharrServices.applySettings(state.settings);
    }
  } catch (_) {
    /* unconfigured services are simply skipped below */
  }

  const locale = window.watcharrI18nLocale
    ? await window.watcharrI18nLocale.fetchLocale()
    : "en";
  await applyLanguage(locale);

  updateViewMenu();
  updateSourceUI();

  dbg("init:", {
    jellyfinUrl:
      (WatcharrServices.byId("jellyfin") || {}).serverUrl || "(none)",
    services: WatcharrServices.list.map(
      (s) => s.id + "=" + (s.urlPattern || "no pattern"),
    ),
  });

  // Header provider switch: it shows the current service and switches to the
  // next open one on click – with three or more open services it cycles
  // through all of them.
  if (els.serviceBtn) {
    els.serviceBtn.addEventListener("click", () => {
      const next = nextService();
      if (!next) return; // nothing to switch to
      switchProvider(next.id);
    });
  }

  // Keep the provider switch in sync with the open tabs (background broadcast
  // as the fast path, local tab events as the fallback).
  bindTabEvents();

  // Safety net: the background broadcasts only on CHANGE, so a state that was
  // already current before this page opened never arrives as a broadcast.
  // Reconcile periodically (cheap – no DOM rewrite when nothing changed); this
  // also heals a missed broadcast.
  setInterval(() => {
    if (!fileMode && !loadingInitial && !exporting)
      refreshProviders(undefined, "interval");
  }, 3000);
  dbg("periodic reconciliation every 3 s started");

  // A hidden tab has its timers throttled, so a change that happened while the
  // user was looking at a service tab may be picked up late. Coming back to
  // this page is exactly when the state has to be right – re-check immediately.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || fileMode || loadingInitial || exporting) return;
    dbg("page visible again – re-checking");
    refreshProviders(undefined, "visible");
  });

  // `refreshProviders` already loads the history when a service tab is open –
  // including the very first detection. The extra `load()` below covers the
  // race where that first reconciliation could not start a load.
  const loadStarted = await refreshProviders(undefined, "init");
  await applyServiceHeader();

  if (!serviceAvailable) {
    await showNoService();
    return;
  }
  if (!loadStarted) load();
}

// A failure while setting up the page must be visible: if the initialization
// throws, the header stays at its initial state and nothing else would explain
// why – so report it instead of leaving an empty console.
initHistory().catch((err) => {
  console.error("[watcharr-scrobbler:history] initialization failed:", err);
});
