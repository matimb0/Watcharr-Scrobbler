/*
 * Watcharr Scrobbler – Options page.
 * Manages Watcharr URL, login (token), language selection, and scrobbling settings.
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

// Active login method and the providers the server currently reports as
// available (auto-detected via GET /api/auth/available).
let method = "watcharr"; // "watcharr" | "jellyfin" | "plex"
let methodOptions = ["watcharr"];
let useEmby = false;
let configured = false;
let plexPopup = null;
let plexPolling = false;
let plexStartedAt = 0;
let detectTimer = null;

const els = {
  url: $("#watcharrUrl"),
  username: $("#username"),
  password: $("#password"),
  language: $("#language"),
  loginBtn: $("#loginBtn"),
  logoutBtn: $("#logoutBtn"),
  enabled: $("#enabled"),
  threshold: $("#threshold"),
  thresholdValue: $("#thresholdValue"),
  stepsThreshold: $("#stepsThreshold"),
  stepsText: $("#stepsText"),
  banner: $("#status-banner"),
  generalBanner: $("#general-banner"),
  jellyfinBanner: $("#jellyfin-banner"),
  jellyfinUrl: $("#jellyfinUrl"),
  historyBtn: $("#historyBtn"),
  methodField: $("#methodField"),
  providerGroup: $("#providerGroup"),
  methodHint: $("#methodHint"),
  usernameField: $("#usernameField"),
  passwordField: $("#passwordField"),
};

async function t(key, params = {}) {
  return I18NApi.translate(key, currentLanguage, params);
}

function populateLanguageOptions() {
  if (!els.language) return;
  const loc = I18NApi.locale || window.watcharrI18nLocale || {};
  const supported = loc.SUPPORTED_LOCALES || ["en", "de", "fr", "es"];
  const names = loc.LANGUAGE_NAMES || {
    en: "English",
    de: "Deutsch",
    fr: "Français",
    es: "Español",
  };
  els.language.innerHTML = "";
  supported.forEach((code) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = names[code] || code;
    els.language.appendChild(option);
  });
}

populateLanguageOptions();

function showBanner(kind, text) {
  els.banner.className = "banner " + kind;
  els.banner.textContent = text;
}

function showGeneralBanner(kind, text) {
  els.generalBanner.className = "banner " + kind;
  els.generalBanner.textContent = text;
}

function showJellyfinBanner(kind, text) {
  if (!els.jellyfinBanner) return;
  els.jellyfinBanner.className = "banner " + kind;
  els.jellyfinBanner.textContent = text;
}

function clearBanner() {
  els.banner.className = "banner hidden";
  els.banner.textContent = "";
}

/* ---------- Login method (Watcharr / Jellyfin / Plex) ---------- */

function loginLabelKey(m) {
  return m === "jellyfin"
    ? useEmby
      ? "settings.connectEmby"
      : "settings.connectJellyfin"
    : m === "plex"
      ? "settings.connectPlex"
      : "settings.saveConnect";
}

// Stable error codes from the background (background/watcharr-client.js)
// mapped to fully composed, localized messages. Server/network reasons are
// carried as params; unknown codes fall back to a translated wrapper.
async function loginErrorMessage(err) {
  const code = err && err.errorCode;
  const params = (err && err.errorParams) || {};
  const raw = (err && (err.error || err.message)) || "";
  switch (code) {
    case "connection_failed":
      return t("settings.error.connection", {
        reason: params.reason || raw,
      });
    case "login_rejected":
      return t("settings.loginFailed", { error: params.reason || raw });
    case "no_token":
      return t("settings.error.noToken");
    case "plex_network":
      return t("settings.error.plexNetwork", {
        reason: params.reason || raw,
      });
    case "plex_http":
      return t("settings.error.plexHttp", { status: params.status || "" });
    case "plex_invalid":
      return t("settings.error.plexInvalid");
    case "not_configured":
      return t("settings.notConfigured");
    case "url_not_configured":
      return t("settings.missingUrl");
    case "no_active_plex":
      return t("settings.plexTimeout");
    default:
      if (raw) return t("settings.loginFailed", { error: raw });
      return t("settings.error.generic");
  }
}

// Emby is a server-side setting (useEmby). When on, Watcharr labels the same
// "jellyfin" method as "emby" – mirror that on the button through i18n
// (settings.providerEmby) instead of a hardcoded string.
function refreshProviderLabels() {
  const btn = els.providerGroup.querySelector('[data-method="jellyfin"]');
  if (btn && useEmby) {
    btn.textContent =
      I18NApi && I18NApi.tSync
        ? I18NApi.tSync("settings.providerEmby", {}, currentLanguage)
        : "Emby";
  }
}

function renderProviders(list) {
  methodOptions = list.slice();
  ["watcharr", "jellyfin", "plex"].forEach((m) => {
    const btn = els.providerGroup.querySelector('[data-method="' + m + '"]');
    if (btn) btn.classList.toggle("hidden", !list.includes(m));
  });
  refreshProviderLabels();
  if (!list.includes(method)) {
    selectMethod("watcharr");
  } else {
    updateLoginView();
  }
}

async function selectMethod(next) {
  method = next;
  updateLoginView();
}

function updateLoginView() {
  if (plexPolling) return; // keep the "Waiting for Plex…" state stable
  els.providerGroup.querySelectorAll(".provider").forEach((b) => {
    b.classList.toggle("active", b.dataset.method === method);
  });
  // Jellyfin/Watcharr use username + password; Plex only opens a popup.
  const creds = method === "watcharr" || method === "jellyfin";
  els.usernameField.classList.toggle("hidden", !creds);
  els.passwordField.classList.toggle("hidden", !creds);
  els.loginBtn.disabled = false;

  t(loginLabelKey(method)).then((label) => {
    if (!els.loginBtn.disabled) els.loginBtn.textContent = label;
  });

  const hintKey =
    method === "jellyfin"
      ? "settings.jellyfinHint"
      : method === "plex"
        ? "settings.plexHint"
        : "";
  if (hintKey) {
    t(hintKey).then((hint) => {
      els.methodHint.textContent = hint;
    });
    els.methodHint.classList.remove("hidden");
  } else {
    els.methodHint.classList.add("hidden");
    els.methodHint.textContent = "";
  }
}

// Ask the server which login providers are enabled and show only those.
async function detectProviders() {
  const url = els.url.value.trim();
  let available = [];
  useEmby = false;
  if (url && !configured) {
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:auth:available",
        url,
      });
      if (resp && resp.ok) {
        available = resp.available || [];
        useEmby = !!resp.useEmby;
      }
    } catch (_) {
      // Server unreachable -> fall back to showing only the Watcharr login.
    }
  }
  const list = ["watcharr"];
  if (available.includes("jellyfin")) list.push("jellyfin");
  if (available.includes("plex")) list.push("plex");
  renderProviders(list);
}

function setLoginBusy(busy, label) {
  els.loginBtn.disabled = busy;
  if (label !== undefined) els.loginBtn.textContent = label;
  els.providerGroup.querySelectorAll(".provider").forEach((b) => {
    b.disabled = busy;
  });
}

async function updateStepText(threshold) {
  if (!els.stepsText) return;
  const before = await t("settings.step4Before");
  const after = await t("settings.step4After");
  // Build the sentence with plain text + a real <span>; `after` comes from our
  // own translations and may contain trusted inline markup (e.g. <em>), so it
  // is rendered through the safe allow-list helper (never innerHTML).
  const trustedMarkup =
    window.watcharrI18n && window.watcharrI18n.trustedMarkupToFragment;
  els.stepsText.replaceChildren();
  els.stepsText.appendChild(document.createTextNode(before + " "));
  const span = document.createElement("span");
  span.id = "stepsThreshold";
  span.textContent = String(threshold);
  els.stepsText.appendChild(span);
  els.stepsText.appendChild(
    trustedMarkup ? trustedMarkup(after) : document.createTextNode(after || ""),
  );
  els.stepsThreshold = span;
}

// `persist` stores the language as an explicit user choice (mirror for sync
// reads). Auto-detected languages must NOT be persisted – otherwise the
// "use the browser language" default would be frozen after the first load.
async function applyLanguage(lang, persist = false) {
  currentLanguage = I18NApi.resolveLanguage(lang);
  await I18NApi.applyTranslations(currentLanguage, document);
  document.documentElement.lang = currentLanguage;
  if (els.language) els.language.value = currentLanguage;
  if (persist) {
    const loc = I18NApi.locale || window.watcharrI18nLocale;
    if (loc && loc.writeLocale) loc.writeLocale(currentLanguage);
  }
  // (Re-)apply the Emby override after the static data-i18n sweep.
  refreshProviderLabels();
}

async function load() {
  const resp = await browser.runtime.sendMessage({ type: "watcharr:getState" });
  if (!resp || !resp.ok) return;

  const s = resp.settings;
  configured = !!s.configured;

  // `s.language` is "" while no language has been chosen yet -> resolve to
  // the browser language (detected in i18n/locale.js). Only persist a mirror
  // when the language was explicitly stored.
  currentLanguage = I18NApi.resolveLanguage(s.language || "");
  await applyLanguage(currentLanguage, !!s.language);

  els.url.value = s.watcharrUrl || "";
  els.username.value = s.username || "";
  els.enabled.checked = s.enabled !== false;
  els.threshold.value = s.threshold || 90;
  els.thresholdValue.value = s.threshold + " %";
  els.stepsThreshold.textContent = s.threshold || 90;
  if (els.jellyfinUrl) els.jellyfinUrl.value = s.jellyfinUrl || "";
  await updateStepText(s.threshold || 90);

  if (configured) {
    // Connected: the method selector is not needed (the stored token is used).
    method = "watcharr";
    els.methodField.classList.add("hidden");
    els.usernameField.classList.remove("hidden");
    els.passwordField.classList.remove("hidden");
    els.logoutBtn.classList.remove("hidden");
    els.password.placeholder = await t("settings.passwordPlaceholder");
    showBanner(
      "success",
      await t("settings.connected", { username: s.username || "?" }),
    );
  } else {
    els.methodField.classList.remove("hidden");
    els.logoutBtn.classList.add("hidden");
    showBanner("info", await t("settings.notConfigured"));
    if (!methodOptions.includes(method)) method = "watcharr";
    updateLoginView();
    detectProviders();
  }
}

async function login() {
  if (plexPolling) return;
  const url = els.url.value.trim();
  const username = els.username.value.trim();
  const password = els.password.value;

  if (method !== "plex" && (!url || !username || !password)) {
    showBanner("error", await t("settings.missingFields"));
    return;
  }

  // Ask for the host access right here – everything above is synchronous, so
  // this click still counts as the user gesture the request needs (see
  // requestHostAccess). Waiting for the login round-trip first would lose it.
  const accessPromise = requestHostAccess();

  if (method === "plex") {
    await startPlexLogin();
    return;
  }

  setLoginBusy(true, await t("settings.connecting"));
  clearBanner();

  try {
    // Wait for the answer to the prompt before talking to the server: without
    // the host permission the login request could not leave the extension.
    await accessPromise;
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:login",
      url,
      username,
      password,
      method: method === "jellyfin" ? "jellyfin" : "watcharr",
    });
    if (resp && resp.ok) {
      els.password.value = "";
      showBanner(
        "success",
        await t("settings.connected", { username: resp.username }),
      );
      await load();
    } else {
      showBanner("error", await loginErrorMessage(resp));
    }
  } catch (err) {
    showBanner("error", await loginErrorMessage(err));
  } finally {
    setLoginBusy(false, await t(loginLabelKey(method)));
  }
}

/* ---------- Plex OAuth (plex.tv popup) ---------- */

async function startPlexLogin() {
  const url = els.url.value.trim();
  if (!url) {
    showBanner("error", await t("settings.missingUrl"));
    return;
  }
  if (plexPolling) return;

  // Open the popup synchronously while the click's user activation is valid
  // (popup blockers would otherwise swallow it). The real plex.tv URL is set
  // below once the pin has been created.
  let popup = null;
  try {
    popup = window.open(
      "",
      "Watcharr · Plex Login",
      "width=600,height=800,scrollbars=yes",
    );
  } catch (_) {
    popup = null;
  }

  clearBanner();
  setLoginBusy(true, await t("settings.plexWaiting"));
  plexStartedAt = Date.now();
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:plex:begin",
      url,
    });
    if (!resp || !resp.ok) throw new Error(await loginErrorMessage(resp));
    if (!popup) throw new Error(await t("settings.plexPopupBlocked"));

    plexPopup = popup;
    try {
      // Navigating to plex.tv destroys the `window.open` reference in Firefox
      // (it becomes a "dead object"), so no popup property may be accessed
      // after this point. The background pin poll is the source of truth, not
      // the popup window.
      popup.location.href = resp.authUrl;
      popup.focus();
    } catch (_) {
      // Popup already gone (e.g. closed while the pin was being created) –
      // keep polling; the timeout below will end the flow.
    }
    plexPolling = true;
    pollPlex();
  } catch (err) {
    try {
      if (popup) popup.close();
    } catch (_) {}
    setLoginBusy(false);
    updateLoginView();
    // `err` was already composed from translated parts (loginErrorMessage /
    // plexPopupBlocked), so it is shown directly without another wrapper.
    showBanner("error", err.message);
  }
}

// The plex.tv popup is only ever *written* to, never read back: as soon as it
// navigates to app.plex.tv, Firefox drops the `window.open` reference into a
// "dead object" where even reading `popup.closed` throws. Closing is therefore
// best-effort only (and may silently fail once the reference is dead).
function closePlexPopup() {
  try {
    if (plexPopup) plexPopup.close();
  } catch (_) {}
}

async function pollPlex() {
  if (!plexPolling) return;

  // Safety net: the plex.tv pin expires after a few minutes.
  if (Date.now() - plexStartedAt > 5 * 60 * 1000) {
    stopPlexPolling();
    showBanner("info", await t("settings.plexTimeout"));
    return;
  }

  let resp = null;
  try {
    resp = await browser.runtime.sendMessage({ type: "watcharr:plex:poll" });
  } catch (_) {
    resp = null; // transient background error -> keep polling
  }

  if (resp && resp.ok && resp.authToken) {
    await finishPlexLogin(resp.authToken);
    return;
  }
  if (
    resp &&
    resp.ok === false &&
    (resp.errorCode === "no_active_plex" || /no active/i.test(resp.error || ""))
  ) {
    // Nothing left to wait for – the flow was consumed or reset.
    stopPlexPolling();
    showBanner("info", await t("settings.plexTimeout"));
    return;
  }
  // Deliberately do NOT stop when the popup looks closed/unreachable:
  // app.plex.tv closes its window right after the user approves the login, and
  // in Firefox the popup reference dies as soon as it navigates there. Both
  // look like a "closed popup" but are signs the flow is progressing. Only the
  // background pin poll (authToken above) or the timeout below end it.
  setTimeout(pollPlex, 1500);
}

function stopPlexPolling() {
  plexPolling = false;
  closePlexPopup();
  plexPopup = null;
  setLoginBusy(false);
  updateLoginView();
}

async function finishPlexLogin(authToken) {
  plexPolling = false;
  closePlexPopup();
  plexPopup = null;
  const url = els.url.value.trim();
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:loginPlex",
      url,
      token: authToken,
    });
    if (resp && resp.ok) {
      setLoginBusy(false);
      showBanner(
        "success",
        await t("settings.connected", { username: resp.username || "Plex" }),
      );
      await load();
    } else {
      setLoginBusy(false);
      updateLoginView();
      showBanner("error", await loginErrorMessage(resp));
    }
  } catch (err) {
    setLoginBusy(false);
    updateLoginView();
    showBanner("error", await loginErrorMessage(err));
  }
}

async function logout() {
  await browser.runtime.sendMessage({ type: "watcharr:logout" });
  if (plexPolling) {
    plexPolling = false;
    closePlexPopup();
    plexPopup = null;
  }
  els.username.value = "";
  els.password.value = "";
  els.password.placeholder = await t("settings.passwordPlaceholder");
  els.logoutBtn.classList.add("hidden");
  method = "watcharr";
  showBanner("success", await t("settings.loggedOut"));
  await load();
}

async function saveBehaviour() {
  await browser.runtime.sendMessage({
    type: "watcharr:saveSettings",
    settings: {
      enabled: els.enabled.checked,
      threshold: parseInt(els.threshold.value, 10),
      // language is intentionally NOT included: it is only persisted when the
      // user picks one explicitly in the language dropdown.
    },
  });
  await applyLanguage(els.language ? els.language.value : currentLanguage);
  await updateStepText(parseInt(els.threshold.value, 10));
}

/**
 * Origins the extension needs for what is in the form right now: the Watcharr
 * instance, the (self-hosted) Jellyfin server and the fixed service hosts.
 * Built synchronously from the form fields, because it has to happen before the
 * permission request – see requestHostAccess().
 */
function requestOrigins() {
  if (!window.WatcharrServices) return [];
  return WatcharrServices.permissionOrigins({
    watcharrUrl: els.url ? els.url.value.trim() : "",
    jellyfinUrl: els.jellyfinUrl ? els.jellyfinUrl.value.trim() : "",
  });
}

/**
 * Asks for access to the hosts that are only known from the settings: the
 * self-hosted Jellyfin server and the user's Watcharr instance. Both are
 * declared nowhere in the manifest (their URLs are typed in here), so the
 * permission has to be requested at runtime – and a runtime request needs a
 * user gesture, which the click on "Save"/leaving the field provides.
 *
 * The request MUST start inside that gesture: every `await` before it (a
 * background round-trip, a permissions.contains check) ends the task, and
 * Firefox then drops the request without a prompt and without an error. So the
 * origins come from the form fields and permissions.request is the first call.
 *
 * If nothing is missing, no prompt is shown at all.
 */
function requestHostAccess() {
  if (!browser.permissions || !browser.permissions.request) {
    return Promise.resolve(true);
  }
  const origins = requestOrigins();
  if (!origins.length) return Promise.resolve(true);
  let request;
  try {
    request = browser.permissions.request({ origins }); // no await above!
  } catch (err) {
    console.warn("[watcharr-scrobbler] permission request threw:", err);
    return Promise.resolve(false);
  }
  return Promise.resolve(request).catch((err) => {
    console.warn("[watcharr-scrobbler] permission request failed:", err);
    return false;
  });
}

/* ---------- Jellyfin server (self-hosted service) ---------- */

/**
 * Stores the Jellyfin server URL. The background normalizes it and keeps the
 * dynamically registered Jellyfin Content Script in sync (see
 * background/background.js – syncJellyfin); the normalized value is echoed
 * back here so the field shows exactly what is used for tab matching.
 */
async function saveJellyfinUrl() {
  if (!els.jellyfinUrl) return;
  const typed = els.jellyfinUrl.value.trim();
  // The server URL decides which host the extension has to be allowed to read –
  // ask for it right here, while this change event still counts as a user
  // gesture (see requestHostAccess).
  const accessPromise = requestHostAccess();
  const resp = await browser.runtime.sendMessage({
    type: "watcharr:saveSettings",
    settings: { jellyfinUrl: typed },
  });
  if (!resp || !resp.ok) {
    showJellyfinBanner("error", await t("settings.error.generic"));
    return;
  }
  const normalized = resp.jellyfinUrl || "";
  els.jellyfinUrl.value = normalized;
  if (typed && !normalized) {
    // The background could not make sense of the value (no usable http(s) URL).
    showJellyfinBanner("error", await t("settings.jellyfinInvalid"));
    return;
  }
  await accessPromise;
  showJellyfinBanner("success", await t("settings.jellyfinSaved"));
}

els.historyBtn.addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("history/history.html") });
});

els.loginBtn.addEventListener("click", login);
els.logoutBtn.addEventListener("click", logout);

els.providerGroup.querySelectorAll(".provider").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (plexPolling) return;
    if (methodOptions.includes(btn.dataset.method))
      selectMethod(btn.dataset.method);
  });
});

// Re-detect the available providers shortly after the user edits the URL.
els.url.addEventListener("input", () => {
  if (configured) return;
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => detectProviders(), 700);
});

els.threshold.addEventListener("input", async () => {
  const value = parseInt(els.threshold.value, 10);
  els.thresholdValue.value = value + " %";
  if (els.stepsThreshold) els.stepsThreshold.textContent = value;
  await updateStepText(value);
});
els.threshold.addEventListener("change", saveBehaviour);
els.enabled.addEventListener("change", saveBehaviour);

els.language.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "watcharr:saveSettings",
    settings: { language: els.language.value },
  });
  // Explicit user choice -> persist the mirror as well.
  await applyLanguage(els.language.value, true);
  showGeneralBanner("success", await t("settings.languageSaved"));
});

els.password.addEventListener("keydown", (e) => {
  if (e.key === "Enter") login();
});

if (els.jellyfinUrl) {
  els.jellyfinUrl.addEventListener("change", saveJellyfinUrl);
  els.jellyfinUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveJellyfinUrl();
    }
  });
}

load();
