(function () {
  const STORAGE_KEY = "watcharr_locale";
  const FALLBACK_LOCALE = "en";
  const SUPPORTED_LOCALES = ["en", "de", "fr", "es"];
  const LANGUAGE_NAMES = {
    en: "English",
    de: "Deutsch",
    fr: "Français",
    es: "Español",
  };

  /** Maps "de-DE"/"EN_us"/"fr" to a supported base locale, else "en". */
  function normalizeLocale(locale) {
    if (!locale) return FALLBACK_LOCALE;
    const base = String(locale).trim().split(/[-_]/)[0].toLowerCase();
    return SUPPORTED_LOCALES.includes(base) ? base : FALLBACK_LOCALE;
  }

  /** The browser UI language as a supported locale (default when the user has
   *  not chosen a language explicitly). */
  function detectBrowserLocale() {
    let raw = "";
    try {
      if (
        typeof browser !== "undefined" &&
        browser.i18n &&
        typeof browser.i18n.getUILanguage === "function"
      ) {
        raw = browser.i18n.getUILanguage();
      }
    } catch (_) {}
    if (!raw && typeof navigator !== "undefined") {
      raw =
        (navigator.languages && navigator.languages.length
          ? navigator.languages[0]
          : "") ||
        navigator.language ||
        "";
    }
    return normalizeLocale(raw);
  }

  function readLocale() {
    try {
      const value = window.localStorage
        ? window.localStorage.getItem(STORAGE_KEY)
        : null;
      if (value) return normalizeLocale(value);
    } catch (_) {}

    try {
      const legacy = window.localStorage
        ? window.localStorage.getItem("language")
        : null;
      if (legacy) return normalizeLocale(legacy);
    } catch (_) {}

    // No explicit choice stored -> fall back to the browser language.
    return detectBrowserLocale();
  }

  function writeLocale(locale) {
    const normalized = normalizeLocale(locale);

    try {
      if (
        typeof browser !== "undefined" &&
        browser.storage &&
        browser.storage.local
      ) {
        browser.storage.local.set({ language: normalized });
      }
    } catch (_) {}

    try {
      if (window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, normalized);
      }
    } catch (_) {}

    return normalized;
  }

  function resolveLocale(locale) {
    return normalizeLocale(locale || readLocale());
  }

  /** Async variant that honours the canonical source of truth: the `settings`
   *  object (with `settings.language`) managed by the background script. Falls
   *  back to the synchronous localStorage read when storage is unavailable. */
  async function fetchLocale() {
    try {
      if (
        typeof browser !== "undefined" &&
        browser.storage &&
        browser.storage.local
      ) {
        const data = await browser.storage.local.get(["settings", "language"]);
        const stored =
          (data.settings && data.settings.language) || data.language;
        if (stored) {
          const normalized = normalizeLocale(stored);
          writeLocale(normalized);
          return normalized;
        }
      }
    } catch (_) {}
    return readLocale();
  }

  window.watcharrI18nLocale = {
    SUPPORTED_LOCALES,
    LANGUAGE_NAMES,
    readLocale,
    writeLocale,
    resolveLocale,
    fetchLocale,
  };

  window.i18n = window.i18n || {};
  window.i18n.locale = window.watcharrI18nLocale;
})();
