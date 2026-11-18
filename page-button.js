// Content script (all pages). Floating "Ask LLM" liquid-glass button. Lives on every page,
// in a shadow root so page styles can't touch it.

function isEditable(el) {
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

let ASK_NAME = 'DeepSeek';   // which chat the button talks to; follows the side panel's choice
const MAX_CHARS = 6000;
const SETTLE_MS = 120;
const FILTER_ID = 'ask-deepseek-refract';

function cleanText(raw) {
  let t = String(raw || '');
  t = t.replace(/­/g, '');                                   // soft hyphens
  t = t.replace(/([A-Za-zÀ-ɏ])[-‐‑]\s*[\r\n]+\s*(?=[a-zß-ɏ])/g, '$1'); // exam-\nple -> example
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, MAX_CHARS);
}

const STYLE = `
:host { all: initial; }
.btn {
  --mx: 50%; --my: 25%;
  position: fixed; left: 0; top: 0; box-sizing: border-box;
  display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 16px 0 12px; margin: 0;
  border: 0; border-radius: 999px; cursor: pointer; overflow: hidden;
  font: 600 14px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: .01em;
  color: #0a1428;
  background: linear-gradient(135deg, rgba(246,250,255,.74) 0%, rgba(214,228,250,.68) 55%, rgba(206,222,248,.70) 100%);
  -webkit-backdrop-filter: blur(14px) saturate(180%) brightness(1.08);
          backdrop-filter: blur(14px) saturate(180%) brightness(1.08);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.9),
    inset 0 -1px 0 rgba(255,255,255,.38),
    inset 0 0 14px rgba(150,195,255,.38),
    0 0 0 1px rgba(80,110,170,.30),
    0 1px 3px rgba(8,16,40,.20),
    0 10px 28px rgba(8,16,40,.30);
  opacity: 0; transform: scale(.9); visibility: hidden; pointer-events: none;
  transition: opacity .22s ease, transform .22s cubic-bezier(.34,1.56,.64,1), visibility 0s .22s;
  -webkit-tap-highlight-color: transparent;
}
.btn.refract {
  -webkit-backdrop-filter: url(#${FILTER_ID}) blur(14px) saturate(180%) brightness(1.08);
          backdrop-filter: url(#${FILTER_ID}) blur(14px) saturate(180%) brightness(1.08);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .btn { background: linear-gradient(135deg, rgba(246,250,255,.96), rgba(214,228,250,.94)); }
}
.btn.show { opacity: 1; transform: scale(1); visibility: visible; pointer-events: auto;
  transition: opacity .22s ease, transform .22s cubic-bezier(.34,1.56,.64,1), visibility 0s; }
.btn.show:hover { transform: scale(1.04); }
.btn.show:active { transform: scale(.97); }
.btn:focus-visible { outline: 2px solid #0a3fd1; outline-offset: 2px; }
.sheen {
  position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: radial-gradient(90px 46px at var(--mx) var(--my), rgba(255,255,255,.72), rgba(255,255,255,0) 72%);
}
.content { position: relative; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
svg.ic { width: 18px; height: 18px; flex: none; }
.ic-check { display: none; }
.btn.done .ic-main { display: none; }
.btn.done .ic-check { display: block; }
.btn.err { color: #7a0c1c; }
@media (prefers-reduced-motion: reduce) {
  .btn, .btn.show { transition: opacity .01s linear, visibility 0s; transform: none !important; }
}
`;

const ICON_MAIN = `<svg class="ic ic-main" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.5-4.6A8 8 0 1 1 21 12z"/><path d="M12 8.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke="none"/></svg>`;
const ICON_CHECK = `<svg class="ic ic-check" viewBox="0 0 24 24" fill="none" stroke="#0a6b36" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

/**
 * @param {object} o
 * @param {HTMLElement} o.root        element whose subtree selections must be inside
 * @param {(range: Range) => {title: string, page: string}} o.getSource
 * @param {(payload: object) => Promise<{ok: boolean}>} o.send
 */
function createAskButton({ getSource, send }) {
  const host = document.createElement('div');
  host.id = 'ask-deepseek-host';
  // own top-most stacking context, so pages with positioned/z-indexed layers (e.g. the PDF reader) can't cover the button
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${STYLE}</style>
    <button class="btn" type="button" aria-live="polite">
      <span class="sheen"></span>
      <span class="content">${ICON_MAIN}${ICON_CHECK}<span class="label">Ask ${ASK_NAME}</span></span>
    </button>`;
  const btn = shadow.querySelector('.btn');
  const label = shadow.querySelector('.label');
  document.documentElement.appendChild(host);

  // SVG refraction filter lives in the light DOM (url() refs resolve against the document).
  const refractionSupported = !!(window.CSS && CSS.supports &&
    CSS.supports('backdrop-filter', `url(#${FILTER_ID}) blur(1px)`) && /Chrome\//.test(navigator.userAgent));
  if (refractionSupported) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;pointer-events:none';
    svg.innerHTML = `<filter id="${FILTER_ID}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.022" numOctaves="2" seed="7" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="12" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`;
    document.documentElement.appendChild(svg);
    btn.classList.add('refract');
  }

  let enabled = false;
  let timer = null;
  let hideTimer = null;
  let mouseDown = false;
  let busy = false;
  let changedWhileBusy = false;

  function resetLabel() {
    btn.classList.remove('done', 'err');
    label.textContent = 'Ask ' + ASK_NAME;
  }

  function hide() {
    clearTimeout(timer);
    btn.classList.remove('show');
  }

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (host.contains(range.commonAncestorContainer) || isEditable(document.activeElement)) return null;
    const text = cleanText(sel.toString());
    return text ? { sel, range, text } : null;
  }

  function endRect(sel, range) {
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    // Place near the focus end (where the drag finished).
    let backward = false;
    if (sel.anchorNode && sel.focusNode) {
      const c = sel.anchorNode.compareDocumentPosition(sel.focusNode);
      backward = c & Node.DOCUMENT_POSITION_PRECEDING ||
        (sel.anchorNode === sel.focusNode && sel.anchorOffset > sel.focusOffset);
    }
    return backward ? { r: rects[0], x: rects[0].left } : { r: rects[rects.length - 1], x: rects[rects.length - 1].right };
  }

  function place(end) {
    const gap = 8, m = 8;
    const w = btn.offsetWidth || 150, h = btn.offsetHeight || 40;
    let left = Math.min(Math.max(end.x - w / 2, m), window.innerWidth - w - m);
    let top = end.r.bottom + gap;
    if (top + h > window.innerHeight - m) top = end.r.top - h - gap;          // flip above
    top = Math.min(Math.max(top, m), window.innerHeight - h - m);
    btn.style.left = Math.round(left) + 'px';
    btn.style.top = Math.round(top) + 'px';
  }

  function evaluate() {
    if (!enabled || mouseDown || busy) return;
    const cur = currentSelection();
    if (!cur) return hide();
    const end = endRect(cur.sel, cur.range);
    if (!end) return hide();
    clearTimeout(hideTimer);
    resetLabel();
    place(end);
    btn.classList.add('show');
  }

  function schedule() {
    clearTimeout(timer);
    if (!enabled || (document.body && document.body.hasAttribute('data-annot'))) return hide();   // reader: annotating, selections are for highlights
    timer = setTimeout(evaluate, SETTLE_MS);
  }

  document.addEventListener('selectionchange', () => {
    if (busy) { changedWhileBusy = true; return; }
    const s = window.getSelection();
    if (!s || s.isCollapsed) hide(); else { btn.classList.remove('show'); schedule(); }
  });
  document.addEventListener('mousedown', (e) => { if (!e.composedPath().includes(btn)) mouseDown = true; }, true);
  document.addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; schedule(); } }, true);
  document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') schedule(); });
  window.addEventListener('scroll', () => { if (!busy) hide(); }, true);
  window.addEventListener('resize', hide);

  // Keep the selection alive when pressing the button.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('pointermove', (e) => {
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    btn.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
  });
  btn.addEventListener('pointerleave', () => { btn.style.setProperty('--mx', '50%'); btn.style.setProperty('--my', '25%'); });

  btn.addEventListener('click', async () => {
    if (busy) return;
    const cur = currentSelection();
    if (!cur) return hide();
    busy = true;
    changedWhileBusy = false;
    btn.classList.add('done');
    label.textContent = 'Added';
    let failed = false;
    try {
      const src = getSource(cur.range);
      const res = await send({ text: cur.text, title: src.title, page: src.page, url: src.url });
      failed = !res || !res.ok;
    } catch { failed = true; }
    if (failed) {
      const stale = !(chrome.runtime && chrome.runtime.id);   // extension was reloaded: this page's script is orphaned
      btn.classList.remove('done'); btn.classList.add('err');
      label.textContent = stale ? 'Extension updated. Reload this page.' : 'Not sent. Open the panel.';
    }
    hideTimer = setTimeout(() => { hide(); busy = false; if (changedWhileBusy) schedule(); }, failed ? 2600 : 900);
  });

  return {
    refreshLabel() { if (!busy && !btn.classList.contains('done') && !btn.classList.contains('err')) resetLabel(); },
    setEnabled(v) { enabled = !!v; if (!enabled) { busy = false; hide(); } else schedule(); },
    hide
  };
}

/* ---------- bootstrap ---------- */

(async function () {
  if (globalThis.__askDeepSeekPage) return;
  globalThis.__askDeepSeekPage = true;
  // In the PDF reader the button is always available and opens the side panel itself;
  // on ordinary pages it only exists while the side panel is already open.
  const IS_READER = location.protocol === 'chrome-extension:' && location.pathname.endsWith('/viewer.html');
  const HOST_PROVIDER = Object.values(ASK_PROVIDERS).find(p => new URL(p.origin).hostname === location.hostname);

  // A chat site is "embedded" when it is the chat itself: inside our side panel, or in our popup window.
  // Opened as an ordinary tab, it is just another page, and the button sends to the side panel as usual
  // (so you can ask DeepSeek in the panel about a Claude or ChatGPT conversation, or about DeepSeek itself).
  let embedded = false;
  if (HOST_PROVIDER) {
    const extOrigin = new URL(chrome.runtime.getURL('/')).origin;
    embedded = Array.from(location.ancestorOrigins || []).includes(extOrigin);
    if (!embedded && window.top === window) {
      embedded = await chrome.runtime.sendMessage({ type: 'is-chat-popup' }).then(r => !!(r && r.popup)).catch(() => false);
    }
  }

  // Embedded: the button is for selecting text in the chat's own replies and fills this same message box.
  // Claude, ChatGPT and Gemini have their own button for that, so ours only runs inside DeepSeek. Always on.
  if (embedded) {
    if (!HOST_PROVIDER.replyButton) return;
    ASK_NAME = HOST_PROVIDER.name;
    const own = createAskButton({
      getSource: () => ({ title: 'your earlier response', url: '' }),
      send: async (payload) => typeof globalThis.__askDeepSeekPrefill === 'function'
        ? globalThis.__askDeepSeekPrefill({ kind: 'response', text: payload.text, title: payload.title })
        : { ok: false }
    });
    own.setEnabled(true);
    return;
  }

  let btn = null;
  let panelOpen = false;
  let windowId = null;
  const setName = (id) => {
    const p = ASK_PROVIDERS[id];
    if (p) { ASK_NAME = p.name; if (btn) btn.refreshLabel(); }
  };
  chrome.storage.local.get({ provider: ASK_DEFAULT_PROVIDER }).then(v => setName(v.provider)).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.provider) setName(ch.provider.newValue); });
  if (IS_READER) chrome.windows.getCurrent().then(w => { windowId = w.id; }).catch(() => {});

  function apply(v) {
    panelOpen = !!v;
    const enabled = panelOpen || IS_READER;
    if (enabled && !btn) {
      btn = createAskButton({
        getSource: (range) => typeof globalThis.askDeepSeekSource === 'function'
          ? globalThis.askDeepSeekSource(range)   // set by the PDF reader (adds page numbers)
          : { title: document.title || location.hostname, url: location.href.split('#')[0] },
        send: async (payload) => {
          // Must start inside the click for Chrome to allow opening the panel.
          const opening = IS_READER && !panelOpen && windowId !== null
            ? chrome.sidePanel.open({ windowId }).then(() => true, (e) => { console.warn('[Ask LLM] sidePanel.open failed:', e && e.message); return false; }) : null;
          const res = await chrome.runtime.sendMessage({ type: 'ask-selection', payload, queueIfClosed: IS_READER && !panelOpen });
          // If open() was refused but the panel was already up, the text was delivered directly: that's fine.
          if (opening && !(await opening) && (!res || res.queued || !res.ok)) return { ok: false, reason: 'could-not-open' };
          return res;
        }
      });
    }
    if (btn) btn.setEnabled(enabled);
  }

  // The panel-state push (and re-query) decides visibility on ordinary pages.
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'panel-state') apply(msg.open); });
  const refresh = () => chrome.runtime.sendMessage({ type: 'get-panel-state' }).then(r => apply(r && r.open)).catch(() => {});
  apply(false);
  refresh();

  // Self-heal: if a push was missed (service worker restart, ...), re-ask when the user selects text.
  let lastAsk = 0;
  document.addEventListener('selectionchange', () => {
    if (panelOpen || Date.now() - lastAsk < 800) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    lastAsk = Date.now();
    refresh();
  });
})();
