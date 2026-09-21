/*
 * i18n facade.
 *
 * Combines the translation store (i18n/messages.js) and the DOM sweep
 * (i18n/dom.js) into the single `window.watcharrI18n` / `window.i18n` object the
 * pages use. Loaded last of the i18n files.
 *
 * Load order in the pages: locale.js -> messages.js -> dom.js -> index.js.
 */
"use strict";

(function () {
  const messages = globalThis.WatcharrI18nMessages;
  const dom = globalThis.WatcharrI18nDom;

  const api = {
    FALLBACK_LOCALE: messages.FALLBACK_LOCALE,
    resolveLocale: messages.resolveLocale,
    readLocale: messages.readLocale,
    loadTranslations: messages.loadTranslations,
    t: messages.t,
    tSync: messages.tSync,
    applyTranslations: dom.applyTranslations,
    setTrustedMarkup: dom.setTrustedMarkup,
    trustedMarkupToFragment: dom.trustedMarkupToFragment,
  };

  window.watcharrI18n = api;
  window.i18n = window.i18n || {};
  Object.assign(window.i18n, api);

  // Aliases the pages use; `applyTranslations` takes (locale, rootNode) and
  // `translate` takes (key, locale, params).
  window.i18n.resolveLanguage = messages.resolveLocale;
  window.i18n.loadLanguage = async (locale) =>
    messages.resolveLocale(locale || messages.readLocale());
  window.i18n.translate = async (key, locale, params = {}) =>
    messages.t(key, params, locale);
  window.i18n.applyTranslations = async (locale, rootNode = document) =>
    dom.applyTranslations(locale, rootNode);
})();
