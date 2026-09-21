(function () {
  const FALLBACK_LOCALE = "en";

  const localeApi = window.watcharrI18nLocale || {
    readLocale: () => FALLBACK_LOCALE,
    resolveLocale: (locale) =>
      FALLBACK_LOCALE === locale ? locale : FALLBACK_LOCALE,
  };

  const cache = {};

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

  // Deep-merge `source` into `target` (leaf by leaf). Used to layer the
  // current locale over English so missing keys degrade to English.
  function mergeLeafByLeaf(target, source) {
    if (isLeaf(source)) return source;
    if (!target || isLeaf(target)) target = {};
    Object.keys(source).forEach((key) => {
      target[key] = mergeLeafByLeaf(target[key], source[key]);
    });
    return target;
  }

  function getValue(data, key) {
    return key.split(".").reduce((value, segment) => {
      if (value && value[segment] !== undefined) return value[segment];
      return undefined;
    }, data);
  }

  async function fetchTranslations(locale) {
    const url = browser.runtime.getURL(`i18n/translations/${locale}.json`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not load translations for ${locale}`);
    }
    return response.json();
  }

  // Caches a fully merged translation table: for non-English locales the
  // selected locale is layered over English, so a missing key falls back to its
  // English value instead of leaking the raw key to the user.
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

  function interpolate(text, params = {}) {
    if (!text) return text;
    return String(text).replace(/\{\s*([\w.-]+)\s*\}/g, (_, key) => {
      const value = params[key];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  async function t(key, params = {}, locale) {
    const translations = await loadTranslations(locale || readLocale());
    const value = getValue(translations, key) || key;
    return interpolate(value, params);
  }

  function tSync(key, params = {}, locale) {
    const translations = cache[resolveLocale(locale || readLocale())] || {};
    const value = getValue(translations, key) || key;
    return interpolate(value, params);
  }

  // Values containing {placeholders} need runtime params, so they are left
  // untouched by the static attribute sweep.
  function needsRuntimeParams(value) {
    return /\{\s*[\w.-]+\s*\}/.test(value);
  }

  // -- Trusted inline markup ---------------------------------------------------
  // `data-i18n-html` values are authored by us in i18n/translations/*.json and
  // may contain a small set of inline tags (e.g. <em>). They are never assigned
  // to innerHTML; instead they are parsed with DOMParser (which never executes
  // scripts) and rebuilt as DOM nodes, allow-listing the tags and dropping all
  // attributes.
  const TRUSTED_INLINE_TAGS = new Set([
    "EM",
    "STRONG",
    "B",
    "I",
    "CODE",
    "BR",
    "SPAN",
  ]);

  // Recursively copies `sourceNodes` (parsed by DOMParser) into `target` using
  // nodes of the live document. Unknown tags are dropped but their text content
  // is kept, so unexpected markup degrades to plain text.
  function appendTrustedNodes(target, sourceNodes) {
    for (const node of sourceNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(node.nodeValue));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toUpperCase();
        if (!TRUSTED_INLINE_TAGS.has(tag)) {
          appendTrustedNodes(target, node.childNodes);
          continue;
        }
        if (tag === "BR") {
          target.appendChild(document.createElement("br"));
          continue;
        }
        const el = document.createElement(tag.toLowerCase());
        appendTrustedNodes(el, node.childNodes); // attributes are not copied
        target.appendChild(el);
      }
    }
  }

  // Parses a trusted HTML string into a detached DocumentFragment containing
  // only allow-listed inline elements (see above).
  function trustedMarkupToFragment(html) {
    const parsed = new DOMParser().parseFromString(
      String(html == null ? "" : html),
      "text/html",
    );
    const fragment = document.createDocumentFragment();
    appendTrustedNodes(fragment, parsed.body.childNodes);
    return fragment;
  }

  // Replaces the content of `element` with the rendered trusted markup.
  function setTrustedMarkup(element, html) {
    element.replaceChildren();
    element.appendChild(trustedMarkupToFragment(html));
  }

  async function applyTranslations(locale, rootNode = document) {
    const resolvedLocale = resolveLocale(locale || readLocale());
    const translations = await loadTranslations(resolvedLocale);
    const node = rootNode || document;

    node.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      const value = getValue(translations, key);
      if (value !== undefined && !needsRuntimeParams(value)) {
        element.textContent = interpolate(value, {});
      }
    });

    // Translation values may contain trusted inline markup (e.g. <em>).
    // Rendered via the safe allow-list helper above instead of innerHTML.
    node.querySelectorAll("[data-i18n-html]").forEach((element) => {
      const key = element.getAttribute("data-i18n-html");
      const value = getValue(translations, key);
      if (value !== undefined && !needsRuntimeParams(value)) {
        setTrustedMarkup(element, interpolate(value, {}));
      }
    });

    node.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
      const key = element.getAttribute("data-i18n-placeholder");
      const value = getValue(translations, key);
      if (value !== undefined) {
        element.setAttribute("placeholder", interpolate(value, {}));
      }
    });

    return resolvedLocale;
  }

  window.watcharrI18n = {
    FALLBACK_LOCALE,
    resolveLocale,
    readLocale,
    loadTranslations,
    t,
    tSync,
    applyTranslations,
    setTrustedMarkup,
    trustedMarkupToFragment,
  };

  window.i18n = window.i18n || {};
  Object.assign(window.i18n, window.watcharrI18n);

  // Aliases used by the extension pages (history / options / popup).
  // `applyTranslations` takes (locale, rootNode).
  window.i18n.resolveLanguage = resolveLocale;
  window.i18n.loadLanguage = async (locale) =>
    resolveLocale(locale || readLocale());
  window.i18n.translate = async (key, locale, params = {}) =>
    t(key, params, locale);
  window.i18n.applyTranslations = async (locale, rootNode = document) =>
    applyTranslations(locale, rootNode);
})();
