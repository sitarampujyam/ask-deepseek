// Side panel: hosts the chat iframe (DeepSeek, Claude, ChatGPT or Gemini), reports "I'm open" to the background via a port,
// and relays selections into the iframe (or shows the popup fallback).

let provider = ASK_PROVIDERS[ASK_DEFAULT_PROVIDER];   // which chat site is showing; remembered in storage
const pname = () => provider.name;
const READY_TIMEOUT_MS = 8000;

const frame = document.getElementById('frame');
const notice = document.getElementById('notice');
const noticeText = document.getElementById('noticeText');
const noticeButtons = document.getElementById('noticeButtons');
const toast = document.getElementById('toast');

let windowId = null;
let port = null;
let ready = false;
let popupOpen = false;
const queue = [];
let readyTimer = null;
let toastTimer = null;

/* ---------- UI helpers ---------- */

function button(label, onClick, primary) {
  const b = document.createElement('button');
  b.textContent = label;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
}

function showNotice(text, buttons) {
  noticeText.textContent = text;
  noticeButtons.replaceChildren(...buttons);
  notice.hidden = false;
}
function hideNotice() { notice.hidden = true; }

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function openPopup() { chrome.runtime.sendMessage({ type: 'open-popup', windowId }); }

function showFallbackNotice() {
  showNotice(
    pname() + ' did not load inside the panel (embedding or sign-in may be blocked). ' +
    'You can use it in a docked popup window instead. Selections will be delivered there.',
    [
      button('Open ' + pname() + ' in a popup window', openPopup, true),
      button('Keep waiting', () => { hideNotice(); armReadyTimer(); }),
      button('Reload panel', () => { hideNotice(); loadFrame(); })
    ]
  );
}

function renderPopupState() {
  document.body.classList.toggle('popup-mode', popupOpen);
  if (popupOpen) {
    showNotice(pname() + ' is open in a popup window. Highlighted text is delivered there.', [
      button('Focus popup', () => chrome.runtime.sendMessage({ type: 'focus-popup', windowId }), true),
      button('Close popup & use panel', () => chrome.runtime.sendMessage({ type: 'close-popup', windowId }))
    ]);
  } else {
    hideNotice();
    if (!ready) armReadyTimer();
  }
}

/* ---------- iframe + ready handshake ---------- */

function armReadyTimer() {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => { if (!ready && !popupOpen) showFallbackNotice(); }, READY_TIMEOUT_MS);
}

function loadFrame() {
  ready = false;
  chatBg = null; applyLook();
  frame.src = provider.url;
  frame.title = provider.name + ' chat';
  armReadyTimer();
}

/* ---------- which chat: DeepSeek / Claude / ChatGPT / Gemini ---------- */

const pickBtn = document.getElementById('pickBtn');
const pickName = document.getElementById('pickName');
const pickMenu = document.getElementById('pickMenu');
const CHECK = '<svg class="ck" viewBox="0 0 24 24"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>';
for (const p of Object.values(ASK_PROVIDERS)) {
  const b = document.createElement('button');
  b.className = 'mi'; b.setAttribute('role', 'menuitemradio'); b.dataset.p = p.id;
  b.innerHTML = CHECK + '<span></span>' + (p.id === ASK_DEFAULT_PROVIDER ? '<small>default</small>' : '');
  b.querySelector('span').textContent = p.name;
  pickMenu.appendChild(b);
}
function paintProvider() {
  pickName.textContent = provider.name;
  pickMenu.querySelectorAll('.mi').forEach(b => b.setAttribute('aria-checked', String(b.dataset.p === provider.id)));
  btnSnap.title = 'Add a snapshot of the current tab to ' + pname();
  btnSummarise.title = "Paste this page's text plus a snapshot and ask " + pname() + ' to summarise it';
  btnReload.title = 'Reload ' + pname() + ' (fixes a stuck sign-in or bot check)';
}
function setMenu(open) {
  pickMenu.hidden = !open; pickBtn.setAttribute('aria-expanded', String(open));
  if (open) menuOpenedAt = Date.now();
  if (open) (pickMenu.querySelector('[aria-checked="true"]') || pickMenu.querySelector('.mi')).focus({ preventScroll: true });
}
function chooseProvider(id) {
  setMenu(false);
  if (!ASK_PROVIDERS[id] || id === provider.id) return;
  provider = ASK_PROVIDERS[id];
  chrome.storage.local.set({ provider: provider.id });
  hideNotice();
  paintProvider();
  loadFrame();
}
pickBtn.addEventListener('click', () => setMenu(pickMenu.hidden));
pickMenu.addEventListener('click', (e) => { const b = e.target.closest('.mi'); if (b) chooseProvider(b.dataset.p); });
pickMenu.addEventListener('keydown', (e) => {
  const items = [...pickMenu.querySelectorAll('.mi')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Escape') { setMenu(false); pickBtn.focus(); }
});
document.addEventListener('pointerdown', (e) => { if (!pickMenu.hidden && !pickMenu.contains(e.target) && !pickBtn.contains(e.target)) setMenu(false); });
let menuOpenedAt = 0;
// Clicking into the chat frame closes the menu (ignore the first moment: a loading chat may grab focus).
window.addEventListener('blur', () => { if (Date.now() - menuOpenedAt > 600) setMenu(false); });

const btnReload = document.getElementById('btnReload');
btnReload.addEventListener('click', () => { hideNotice(); loadFrame(); });

/* ---------- look: follow the reader's theme and colour; sheen follows the pointer ---------- */

const HUE_SHIFT = { violet: 0, magenta: 50, rose: 90, amber: 150, emerald: -105, teal: -75, ocean: -40 };
const systemDark = matchMedia('(prefers-color-scheme: dark)');
function readPref(k, d) { try { const v = localStorage.getItem('askds.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }
let chatBg = null;   // the chat page's own background colour, once it reports it
function luminance(css) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(css || '');
  return m ? (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 : null;
}
function applyLook() {
  const t = readPref('theme', 'system');
  const lum = luminance(chatBg);
  // The bar sits on the chat, so it matches the chat's light/dark; before the chat reports, follow the reader's theme.
  const light = lum !== null ? lum > 0.5 : (t === 'light' || (t === 'system' && !systemDark.matches));
  document.documentElement.style.setProperty('--chat-bg', chatBg || '');
  if (!chatBg) document.documentElement.style.removeProperty('--chat-bg');
  document.documentElement.classList.toggle('light', light);
  document.documentElement.style.setProperty('--hs', (HUE_SHIFT[readPref('hue', 'violet')] || 0) + 'deg');
}
window.addEventListener('storage', (e) => { if (e.key === 'askds.theme' || e.key === 'askds.hue') applyLook(); });   // changed in the reader
systemDark.addEventListener('change', applyLook);
applyLook();
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('preload')));
document.querySelectorAll('.glass').forEach((g) => {
  g.addEventListener('pointermove', (e) => { const r = g.getBoundingClientRect(); g.style.setProperty('--mx', (e.clientX - r.left) + 'px'); g.style.setProperty('--my', (e.clientY - r.top) + 'px'); });
  g.addEventListener('pointerleave', () => { g.style.removeProperty('--mx'); g.style.removeProperty('--my'); });
});

window.addEventListener('message', (event) => {
  if (event.origin !== provider.origin || event.source !== frame.contentWindow) return;
  const d = event.data;
  if (!d || typeof d.type !== 'string') return;
  if (d.type === 'ask-deepseek-bg') {
    if (typeof d.bg === 'string' && /^rgba?\([\d.,\s]+\)$/.test(d.bg)) { chatBg = d.bg; applyLook(); }
    return;
  }
  if (d.type === 'ask-deepseek-ready') {
    ready = true;
    clearTimeout(readyTimer);
    if (!popupOpen) hideNotice();
    flush();
  } else if (d.type === 'ask-deepseek-result' && d.ok !== false) {
    try { window.focus(); frame.focus(); } catch {}
  } else if (d.type === 'ask-deepseek-result' && d.ok === false && d.reason === 'image-not-accepted') {
    copyLastImage().then((ok) => showToast(ok
      ? pname() + " didn't take the snapshot directly. It's on your clipboard: click the message box and press " + (navigator.platform.startsWith('Mac') ? '⌘V' : 'Ctrl+V') + '.'
      : pname() + " didn't accept the snapshot. Try pasting a screenshot yourself."));
  } else if (d.type === 'ask-deepseek-result' && d.ok === false) {
    showToast(d.reason === 'input-not-found'
      ? "Couldn't find " + pname() + "'s message box (signed in? see selectors.js)."
      : 'Could not add text to ' + pname() + '.');
  }
});

// Fallback only when a site refuses the snapshot: put it on the clipboard so one paste finishes the job.
let lastImage = null;
async function copyLastImage() {
  if (!lastImage) return false;
  try {
    const blob = await (await fetch(lastImage)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch { return false; }
}

function post(payload) {
  if (payload.kind === 'image') lastImage = payload.dataUrl;
  try { window.focus(); frame.focus(); } catch {}   // hand keyboard focus to the chat frame so you can type at once
  frame.contentWindow.postMessage({ type: 'ask-deepseek-prefill', payload }, provider.origin);
}
function flush() { while (ready && queue.length) post(queue.shift()); }

function deliver(payload) {
  queue.push(payload);
  flush();
}

/* ---------- tools strip: snapshot + page link of the active tab ---------- */

const btnSnap = document.getElementById('btnSnap');
const btnSummarise = document.getElementById('btnSummarise');
const READER_URL = chrome.runtime.getURL('viewer.html');

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, windowId });
  return t;
}
async function refreshStrip() {
  if (windowId === null) return;
  const t = await activeTab();
  const reader = !!(t && t.url && t.url.startsWith(READER_URL));   // PDFs have their own camera button
  btnSnap.disabled = btnSummarise.disabled = reader;
  const why = reader ? ' (the PDF reader has its own camera button)' : '';
  btnSnap.title = 'Add a snapshot of the current tab to ' + pname() + why;
  btnSummarise.title = "Paste this page's text plus a snapshot and ask " + pname() + ' to summarise it' + why;
}
chrome.tabs.onActivated.addListener(refreshStrip);
chrome.tabs.onUpdated.addListener((id, change) => { if (change.url || change.status === 'complete') refreshStrip(); });

btnSnap.addEventListener('click', async () => {
  const t = await activeTab();
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });   // in memory only, never saved
    deliver({ kind: 'image', dataUrl, title: (t && t.title) || '', page: '' });
    showToast('Snapshot added to ' + pname());
  } catch { showToast("Can't capture this page"); }
});

const MAX_PAGE_TEXT = 60000;
btnSummarise.addEventListener('click', async () => {
  const t = await activeTab();
  if (!t || !t.url || !/^(https?|file):/.test(t.url)) { showToast("Can't read this page"); return; }
  let text = '';
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => (document.body ? document.body.innerText : '') });
    text = String((res && res.result) || '').replace(/\n{3,}/g, '\n\n').trim();
  } catch { showToast("Can't read this page"); return; }
  if (!text) { showToast('This page has no text to summarise'); return; }
  if (text.length > MAX_PAGE_TEXT) text = text.slice(0, MAX_PAGE_TEXT) + '\n[…page text truncated]';
  let dataUrl = null;
  try { dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }); } catch {}   // snapshot of the page right now
  deliver({ kind: 'page', title: t.title || t.url, url: t.url.split('#')[0], text });           // text first, then the image
  if (dataUrl) deliver({ kind: 'image', dataUrl, title: t.title || '', page: '' });
  showToast(dataUrl ? 'Page text and snapshot added to ' + pname() : 'Page text added (snapshot unavailable)');
});

/* ---------- background port ---------- */

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.postMessage({ type: 'hello', windowId });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'close') window.close();
    else if (msg.type === 'deliver') deliver(msg.payload);
    else if (msg.type === 'popup-state') { popupOpen = !!msg.open; renderPopupState(); }
  });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 500); }); // service worker restarted
}

chrome.runtime.onMessage.addListener((msg) => {   // fallback delivery when the port was lost
  if (msg && msg.type === 'deliver-to-panel' && msg.windowId === windowId) deliver(msg.payload);
});

setInterval(() => { try { port && port.postMessage({ type: 'ping' }); } catch {} }, 20000);

(async function init() {
  windowId = (await chrome.windows.getCurrent()).id;
  const saved = await chrome.storage.local.get({ provider: ASK_DEFAULT_PROVIDER });
  provider = ASK_PROVIDERS[saved.provider] || ASK_PROVIDERS[ASK_DEFAULT_PROVIDER];
  paintProvider();
  connect();
  loadFrame();
  refreshStrip();
})();
