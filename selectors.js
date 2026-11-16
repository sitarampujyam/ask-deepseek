// ALL chat-site DOM knowledge (DeepSeek, Claude, ChatGPT, Gemini) lives in this file. If the site changes and prefill
// stops working, edit INPUT_SELECTORS below (usually a one-line fix).
// Loaded before content.js as a content script (shared isolated-world globals).

(function () {
  // Tried in order. First visible match wins.
  const INPUT_SELECTORS = [
    'textarea#chat-input',
    'div.ProseMirror[contenteditable="true"]',                  // Claude
    'div[contenteditable="true"][aria-label*="prompt" i]',     // Claude, Gemini ("Enter a prompt for Gemini")
    '#prompt-textarea',                                         // ChatGPT (signed in)
    'textarea[name="prompt"]',                                  // ChatGPT (signed out / narrow layout)
    'textarea[placeholder*="ChatGPT" i]',
    'rich-textarea div.ql-editor[contenteditable="true"]',      // Gemini
    'textarea[placeholder*="DeepSeek" i]',
    'textarea[placeholder*="message" i]',
    'div[contenteditable="true"][role="textbox"]'
  ];

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function largestVisible(selector) {
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (el.disabled || el.readOnly || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  function findInput() {
    for (const sel of INPUT_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!el.disabled && isVisible(el)) return el;
      }
    }
    // Fallbacks: biggest visible textarea, then biggest visible contenteditable.
    return largestVisible('textarea') ||
           largestVisible('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
  }

  // Cookie banner: we pick the privacy-friendly "Necessary cookies only" button.
  // 1) DeepSeek's own class (seen on the live site), 2) fallback: the innermost element with exactly that text.
  const COOKIE_DECLINE_CLASS = '.cookie_banner-accept-essential-button';
  const COOKIE_DECLINE_TEXT = /^\s*necessary cookies only\s*$/i;

  function findCookieDecline() {
    const byClass = document.querySelector(COOKIE_DECLINE_CLASS);
    if (byClass) return byClass;
    let inner = null;
    for (const el of document.querySelectorAll('body *')) {
      if (COOKIE_DECLINE_TEXT.test(el.textContent || '') && ![...el.children].some(c => COOKIE_DECLINE_TEXT.test(c.textContent || ''))) inner = el;
    }
    return inner && (inner.closest('button, [role="button"]') || inner);
  }

  globalThis.AskDeepSeekSelectors = { INPUT_SELECTORS, findInput, findCookieDecline };
})();
