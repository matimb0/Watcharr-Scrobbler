/*
 * Applies translations to the DOM.
 *
 * Handled attributes:
 *   data-i18n             – replaces the text content (plain text),
 *   data-i18n-html        – replaces the content, allowing a small set of
 *                           inline tags (see TRUSTED_INLINE_TAGS),
 *   data-i18n-title       – sets the `title` attribute (tooltips),
 *   data-i18n-placeholder – sets the `placeholder` attribute.
 *
 * Values containing {placeholders} need runtime parameters, so the static sweep
 * leaves them alone – the pages set those themselves via `t(...)`.
 */
"use strict";

(function () {
  const M = globalThis.WatcharrI18nMessages;

  /** Values with {placeholders} need runtime params -> not applied here. */
  function needsRuntimeParams(value) {
    return /\{\s*[\w.-]+\s*\}/.test(value);
  }

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

  /**
   * Copies `sourceNodes` (parsed by DOMParser) into `target` using nodes of the
   * live document. Unknown tags are dropped but their text is kept, so
   * unexpected markup degrades to plain text.
   */
  function appendTrustedNodes(target, sourceNodes) {
    for (const node of sourceNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(node.nodeValue));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = node.tagName.toUpperCase();
      if (!TRUSTED_INLINE_TAGS.has(tag)) {
        appendTrustedNodes(target, node.childNodes);
        continue;
      }
      if (tag === "BR") {
        target.appendChild(document.createElement("br"));
        continue;
      }
      const element = document.createElement(tag.toLowerCase());
      appendTrustedNodes(element, node.childNodes); // attributes are not copied
      target.appendChild(element);
    }
  }

  /** Parses a trusted HTML string into a fragment of allow-listed elements. */
  function trustedMarkupToFragment(html) {
    const parsed = new DOMParser().parseFromString(
      String(html == null ? "" : html),
      "text/html",
    );
    const fragment = document.createDocumentFragment();
    appendTrustedNodes(fragment, parsed.body.childNodes);
    return fragment;
  }

  /** Replaces the content of `element` with the rendered trusted markup. */
  function setTrustedMarkup(element, html) {
    element.replaceChildren();
    element.appendChild(trustedMarkupToFragment(html));
  }

  /** Applies all `data-i18n*` attributes below `rootNode`. */
  async function applyTranslations(locale, rootNode = document) {
    const resolvedLocale = M.resolveLocale(locale || M.readLocale());
    const translations = await M.loadTranslations(resolvedLocale);
    const node = rootNode || document;

    node.querySelectorAll("[data-i18n]").forEach((element) => {
      const value = M.getValue(translations, element.getAttribute("data-i18n"));
      if (value !== undefined && !needsRuntimeParams(value)) {
        element.textContent = M.interpolate(value, {});
      }
    });

    node.querySelectorAll("[data-i18n-html]").forEach((element) => {
      const value = M.getValue(
        translations,
        element.getAttribute("data-i18n-html"),
      );
      if (value !== undefined && !needsRuntimeParams(value)) {
        setTrustedMarkup(element, M.interpolate(value, {}));
      }
    });

    node.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
      const value = M.getValue(
        translations,
        element.getAttribute("data-i18n-placeholder"),
      );
      if (value !== undefined) {
        element.setAttribute("placeholder", M.interpolate(value, {}));
      }
    });

    node.querySelectorAll("[data-i18n-title]").forEach((element) => {
      const value = M.getValue(
        translations,
        element.getAttribute("data-i18n-title"),
      );
      if (value !== undefined) {
        element.setAttribute("title", M.interpolate(value, {}));
      }
    });

    return resolvedLocale;
  }

  globalThis.WatcharrI18nDom = {
    applyTranslations,
    setTrustedMarkup,
    trustedMarkupToFragment,
  };
})();
