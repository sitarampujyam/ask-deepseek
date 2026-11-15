// Runs on https://chat.deepseek.com/* (all frames). Fills the message box; NEVER sends.
// Two delivery paths:
//  - iframe in the side panel: parent posts a message (origin-checked)
//  - popup window top frame:   chrome.runtime onMessage from the background

(function () {
  if (globalThis.__askDeepSeekLoaded) return;
  globalThis.__askDeepSeekLoaded = true;

  const { findInput, findCookieDecline } = globalThis.AskDeepSeekSelectors;
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
  const isTop = window.top === window;

  /* ---------- text helpers ---------- */

  function buildBlock(p) {
    const page = p.page ? (String(p.page).includes('–') ? `, pages ${p.page}` : `, page ${p.page}`) : '';
    const url = p.url ? ` (${p.url})` : '';
    return `Source: ${p.title}${page}${url}\n"""\n${p.text}\n"""\n\n`;
  }
  const HEADER =
    'The user selected the following text and may ask questions about it. If the user says nothing else, just explain the selected text.\n' +
    'Write in simple, lucid language. No introduction or closing remarks, no filler or AI-sounding phrasing. ' +
    'Get straight to the point, be accurate, and explain it well.\n\n';

  const PAGE_HEADER =
    'The user wants a summary of the web page below. The page text was copied from the page and a screenshot of it follows.\n' +
    'Summarise the page. If the user adds a question after this, do not summarise; answer that question instead.\n' +
    'Write in simple, lucid language. No introduction or closing remarks, no filler or AI-sounding phrasing. ' +
    'Get straight to the point, be accurate, and explain it well.\n\n';

  const RESPONSE_HEADER =
    'The user selected the following text from your previous response and may ask questions about it. If the user says nothing else, just explain the selected text.\n' +
    'Write in simple, lucid language. No introduction or closing remarks, no filler or AI-sounding phrasing. ' +
    'Get straight to the point, be accurate, and explain it well.\n\n';

  function readValue(el) {
    return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el.innerText || '');
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function placeCaretAtEnd(el) {
    el.focus();
    if ('setSelectionRange' in el) {
      const n = el.value.length;
      el.setSelectionRange(n, n);
      el.scrollTop = el.scrollHeight;
    } else {
      const sel = getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  function fill(el, payload) {
    const existing = readValue(el).replace(/​/g, '');
    const empty = existing.trim() === '';
    const isPage = payload.kind === 'page';
    const block = isPage ? `Page: ${payload.title}\nURL: ${payload.url}\n"""\n${payload.text}\n"""\n\n` : buildBlock(payload);
    const header = isPage ? PAGE_HEADER : payload.kind === 'response' ? RESPONSE_HEADER : HEADER;
    const isTextControl = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

    if (isTextControl) {
      let next;
      if (empty) next = header + block;
      else next = existing + (existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n') + block;
      el.focus();
      setNativeValue(el, next);
    } else {
      // contenteditable: go through execCommand so editor frameworks see real input events.
      el.focus();
      placeCaretAtEnd(el);
      const insert = empty ? header + block : (existing.endsWith('\n') ? '\n' : '\n\n') + block;
      const ok = document.execCommand && document.execCommand('insertText', false, insert);
      if (!ok) {
        el.textContent = (empty ? '' : existing) + insert;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: insert }));
      }
    }
    placeCaretAtEnd(el);
  }

  // Image: simulate pasting a file into the message box (never presses send).
  function attachImage(el, payload) {
    const bin = atob(payload.dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = /^data:(image\/\w+);/.exec(payload.dataUrl)[1];
    const file = new File([bytes], 'snapshot.' + (type === 'image/jpeg' ? 'jpg' : 'png'), { type });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  function prefill(payload, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function attempt() {
        const el = findInput();
        if (el) {
          try {
            if (payload.kind === 'image') attachImage(el, payload); else fill(el, payload);
            // Re-assert focus shortly after (the page may re-render the box; the panel may take focus late).
            [60, 250, 600].forEach((t) => setTimeout(() => { const e2 = findInput() || el; if (document.activeElement !== e2) placeCaretAtEnd(e2); }, t));
            resolve({ ok: true });
          }
          catch (e) { resolve({ ok: false, reason: 'fill-error: ' + e.message }); }
        } else if (Date.now() - start > timeoutMs) {
          resolve({ ok: false, reason: 'input-not-found' });
        } else setTimeout(attempt, 250);
      })();
    });
  }

  let chain = Promise.resolve();                       // handle payloads one at a time, in arrival order
  const enqueue = (fn) => (chain = chain.then(fn, fn));
  // Used by page-button.js when you select text inside DeepSeek's own replies (same frame, same extension).
  globalThis.__askDeepSeekPrefill = (p) => enqueue(() => prefill(p));

  function validPayload(p) {
    if (p && p.kind === 'page') return typeof p.url === 'string' && /^(https?|file):/.test(p.url) && typeof p.title === 'string' && typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 70000;
    if (p && p.kind === 'image') return typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:image/');
    if (p && p.kind === 'response') return typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 6000;
    return p && typeof p === 'object' && typeof p.text === 'string' && p.text.length > 0 &&
           typeof p.title === 'string' && p.text.length <= 6000;
  }

  /* ---------- iframe path ---------- */

  window.addEventListener('message', async (event) => {
    if (isTop) return;
    if (event.origin !== EXT_ORIGIN || event.source !== window.parent) return;
    const d = event.data;
    if (!d || d.type !== 'ask-deepseek-prefill' || !validPayload(d.payload)) return;
    const result = await enqueue(() => prefill(d.payload));
    event.source.postMessage({ type: 'ask-deepseek-result', ...result }, event.origin);
  });

  /* ---------- popup (top-frame) path ---------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isTop || sender.id !== chrome.runtime.id || !msg || msg.type !== 'prefill' || !validPayload(msg.payload)) return;
    enqueue(() => prefill(msg.payload)).then(sendResponse);
    return true;
  });

  /* ---------- cookie banner ---------- */
  // DeepSeek can't keep its cookie choice when embedded, so it would ask every time. Answer it once per load
  // with "Necessary cookies only" (user's request). Watches for up to 60 s, then stops.

  (function dismissCookieBanner() {
    let done = false;
    const tryClick = () => {
      if (done) return;
      const b = findCookieDecline();
      if (b) { done = true; b.click(); obs.disconnect(); }
    };
    const obs = new MutationObserver(tryClick);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    tryClick();
    setTimeout(() => obs.disconnect(), 60000);
  })();

  /* ---------- ready signal ---------- */

  if (isTop) chrome.runtime.sendMessage({ type: 'cs-ready' }).catch(() => {});
  else window.parent.postMessage({ type: 'ask-deepseek-ready' }, EXT_ORIGIN);
})();
