/*
 * Translation store: loading the JSON files, merging them over the English
 * fallback and looking up/interpolating a key.
 *
 * Loaded after i18n/locale.js (which detects and stores the language) and
 * before i18n/dom.js (which applies the texts to the page).
 */
"use strict";

(function () {
  const FALLBACK_LOCALE = "en";

  const localeApi = window.watcharrI18nLocale || {
    readLocale: () => FALLBACK_LOCALE,
    resolveLocale: (locale) =>
      locale === FALLBACK_LOCALE ? locale : FALLBACK_LOCALE,
  };

  const cache = {}; // locale -> merged translation table

  function resolveLocale(locale) {
    return localeApi.resolveLocale
      ? localeApi.resolveLocale(locale)
      : FALLBACK_LOCALE;
  }

  function readLocale() {
    return localeApi.readLocale ? localeApi.readLocale() : FALLBACK_LOCALE;
  }

  function isLeaf(value) {
    return value === null || typeof value !== "object";
  }

  /** Deep-merges `source` into `target` (leaf by leaf). */
  function mergeLeafByLeaf(target, source) {
    if (isLeaf(source)) return source;
    if (!target || isLeaf(target)) target = {};
    Object.keys(source).forEach((key) => {
      target[key] = mergeLeafByLeaf(target[key], source[key]);
    });
    return target;
  }

  /** Value of a dotted key ("history.error.noMatch") or undefined. */
  function getValue(data, key) {
    return key.split(".").reduce((value, segment) => {
      if (value && value[segment] !== undefined) return value[segment];
      return undefined;
    }, data);
  }

  /** Replaces {placeholders} with the matching param (missing -> empty). */
  function interpolate(text, params = {}) {
    if (!text) return text;
    return String(text).replace(/\{\s*([\w.-]+)\s*\}/g, (_, key) => {
      const value = params[key];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  async function fetchTranslations(locale) {
    const url = browser.runtime.getURL(`i18n/translations/${locale}.json`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not load translations for ${locale}`);
    }
    return response.json();
  }

  /**
   * Fully merged translation table for a locale. Non-English locales are laid
   * over English, so a missing key falls back to its English value instead of
   * leaking the raw key to the user.
   */
  async function loadTranslations(locale) {
    const safeLocale = resolveLocale(locale);
    if (cache[safeLocale]) return cache[safeLocale];

    const translations = await fetchTranslations(safeLocale);
    if (safeLocale === FALLBACK_LOCALE) {
      cache[safeLocale] = translations;
    } else {
      const english = await fetchTranslations(FALLBACK_LOCALE);
      cache[safeLocale] = mergeLeafByLeaf(
        JSON.parse(JSON.stringify(english)),
        translations,
      );
    }
    return cache[safeLocale];
  }

  async function t(key, params = {}, locale) {
    const translations = await loadTranslations(locale || readLocale());
    return interpolate(getValue(translations, key) || key, params);
  }

  /** Synchronous lookup – only valid for a locale that was loaded before. */
  function tSync(key, params = {}, locale) {
    const translations = cache[resolveLocale(locale || readLocale())] || {};
    return interpolate(getValue(translations, key) || key, params);
  }

  globalThis.WatcharrI18nMessages = {
    FALLBACK_LOCALE,
    resolveLocale,
    readLocale,
    loadTranslations,
    getValue,
    interpolate,
    t,
    tSync,
  };
})();
