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

  // Cookie banners: always pick the privacy-friendly choice (reject / necessary only).
  // 1) known buttons on the live sites, 2) fallback: a button with a "reject"-style label inside something about cookies.
  const COOKIE_REJECT_SELECTORS = [
    '.cookie_banner-accept-essential-button',   // DeepSeek: "Necessary cookies only"
    '[data-testid="consent-reject"]'            // Claude: "Reject"
  ];
  const COOKIE_REJECT_TEXT = /^\s*(necessary cookies only|use necessary cookies only|only necessary cookies|reject|reject all|reject all cookies|reject non-essential( cookies)?|decline|decline all|decline optional cookies)\s*$/i;

  function findCookieDecline() {
    for (const sel of COOKIE_REJECT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!COOKIE_REJECT_TEXT.test(el.innerText || el.textContent || '') || !isVisible(el)) continue;
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        if (/cookie/i.test(p.innerText || '')) return el;
      }
    }
    return null;
  }

  globalThis.AskDeepSeekSelectors = { INPUT_SELECTORS, findInput, findCookieDecline };
})();
