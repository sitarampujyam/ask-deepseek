// Runs on the chat sites in providers.js (all frames). Fills the message box; NEVER sends.
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

  // Sites marked shortIntro in providers.js (Claude) get a short intro with no style instructions.
  const SITE = Object.values(globalThis.ASK_PROVIDERS || {}).find(p => new URL(p.origin).hostname === location.hostname) || {};
  const SHORT_INTRO = !!SITE.shortIntro;
  const SHORT_HEADERS = {
    selection: 'The user selected the following text. If the user asks a question, answer it. If not, explain the selected text.\n\n',
    response: 'The user selected the following text from your previous response. If the user asks a question, answer it. If not, explain the selected text.\n\n',
    page: 'The user wants a summary of the web page below. The page text was copied from the page and a screenshot of it follows. If the user adds a question, answer it instead of summarising.\n\n'
  };

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
    const kind = isPage ? 'page' : payload.kind === 'response' ? 'response' : 'selection';
    const header = SHORT_INTRO ? SHORT_HEADERS[kind] : { page: PAGE_HEADER, response: RESPONSE_HEADER, selection: HEADER }[kind];
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

  // Image: hand the snapshot to the site the way a person would (paste, the attach button's file input,
  // or drag-and-drop). Sites differ, so try them in the order set in providers.js and stop at the first
  // one that makes an attachment appear. Never presses send.
  function snapshotFile(payload) {
    const bin = atob(payload.dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = /^data:(image\/\w+);/.exec(payload.dataUrl)[1];
    return new File([bytes], 'snapshot.' + (type === 'image/jpeg' ? 'jpg' : 'png'), { type });
  }
  const withFile = (file) => { const dt = new DataTransfer(); dt.items.add(file); return dt; };
  const ATTACH = {
    paste(el, file) {
      el.focus();
      return !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: withFile(file), bubbles: true, cancelable: true }));
    },
    drop(el, file) {
      const target = el.closest('form, fieldset') || el;
      const dt = withFile(file);
      for (const t of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      return !target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    input(el, file) {
      const inputs = [...document.querySelectorAll('input[type="file"]')].filter(i => !i.disabled && (!i.accept || /image|\*/.test(i.accept)));
      const near = inputs.find(i => (el.closest('form, fieldset') || document.body).contains(i)) || inputs[0];
      if (!near) return false;
      near.files = withFile(file).files;
      near.dispatchEvent(new Event('input', { bubbles: true }));
      near.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  };
  // Something that looks like a new attachment: an image preview, or a file chip.
  const ATTACHMENT_SEL = 'img[src^="blob:"], img[src^="data:"], [data-testid*="file" i], [data-testid*="attachment" i], [class*="attachment" i], [class*="file-preview" i], [class*="thumbnail" i], uploader-file-preview';
  // Composer area: the form around the box, or a few levels up. Previews appear in here.
  function composerOf(el) {
    let c = el.closest('form, fieldset');
    if (c) return c;
    c = el;
    for (let i = 0; i < 6 && c.parentElement && c.parentElement !== document.body; i++) c = c.parentElement;
    return c;
  }
  let composer = null;
  const countAttachments = () => document.querySelectorAll(ATTACHMENT_SEL).length +
    (composer ? composer.querySelectorAll('img, [style*="background-image"], button').length : 0);
  const nextFrameWait = (ms) => new Promise(r => setTimeout(r, ms));

  async function attachImage(el, payload) {
    const file = snapshotFile(payload);
    composer = composerOf(el);
    const order = SITE.imageVia || ['paste', 'drop', 'input'];
    for (const how of order) {
      const before = countAttachments();
      let handled = false;
      try { handled = ATTACH[how](el, file); } catch { handled = false; }
      if (!handled) continue;
      for (let t = 0; t < 12; t++) {                 // up to ~1.8 s for the preview to show up
        await nextFrameWait(150);
        if (countAttachments() > before) return how;
      }
    }
    throw new Error('image-not-accepted');
  }

  function prefill(payload, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function attempt() {
        const el = findInput();
        if (el) {
          Promise.resolve().then(() => payload.kind === 'image' ? attachImage(el, payload) : fill(el, payload)).then(() => {
            // Re-assert focus shortly after (the page may re-render the box; the panel may take focus late).
            [60, 250, 600].forEach((t) => setTimeout(() => { const e2 = findInput() || el; if (document.activeElement !== e2) placeCaretAtEnd(e2); }, t));
            resolve({ ok: true });
          }, (e) => resolve({ ok: false, reason: e && e.message === 'image-not-accepted' ? 'image-not-accepted' : 'fill-error: ' + (e && e.message) }));
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
  // Chat sites can't keep their cookie choice when embedded, so they ask on every load. Answer once per load
  // with the reject / necessary-only button (see selectors.js). Watches for up to 60 s, then stops.

  (function dismissCookieBanner() {
    let done = false, pending = 0;
    const check = () => {
      pending = 0;
      if (done) return;
      const b = findCookieDecline();
      if (b) { done = true; b.click(); obs.disconnect(); }
    };
    const tryClick = () => { if (!pending && !done) pending = setTimeout(check, 250); };   // at most 4 checks a second
    const obs = new MutationObserver(tryClick);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    tryClick();
    setTimeout(() => obs.disconnect(), 60000);
  })();

  /* ---------- page colour for the side panel ---------- */
  // The panel paints its background in the chat's own colour, so the glass bar looks like it sits on the chat.
  function pageBg() {
    const solid = (el) => {
      for (; el; el = el.parentElement) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
      }
      return null;
    };
    return solid(document.elementFromPoint(Math.round(innerWidth / 2), 2)) || solid(document.body) || null;
  }
  if (!isTop) {
    let last = '';
    const report = () => {
      const bg = pageBg();
      if (bg && bg !== last) { last = bg; window.parent.postMessage({ type: 'ask-deepseek-bg', bg }, EXT_ORIGIN); }
    };
    const watch = new MutationObserver(() => setTimeout(report, 50));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(report, 100));
    let n = 0; const early = setInterval(() => { report(); if (++n >= 15) clearInterval(early); }, 1000);   // sites settle after hydrating
    report();
  }

  /* ---------- ready signal ---------- */

  if (isTop) chrome.runtime.sendMessage({ type: 'cs-ready' }).catch(() => {});
  else window.parent.postMessage({ type: 'ask-deepseek-ready' }, EXT_ORIGIN);
})();
