// Side panel: hosts the chat iframe (DeepSeek or Claude), reports "I'm open" to the background via a port,
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
  frame.src = provider.url;
  frame.title = provider.name + ' chat';
  armReadyTimer();
}

/* ---------- DeepSeek / Claude switch ---------- */

const pseg = document.getElementById('providerSeg');
function paintProvider() {
  pseg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.p === provider.id)));
  btnSnap.title = 'Add a snapshot of the current tab to ' + pname();
  btnSummarise.title = "Paste this page's text plus a snapshot and ask " + pname() + ' to summarise it';
}
pseg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.p === provider.id) return;
  provider = ASK_PROVIDERS[b.dataset.p];
  chrome.storage.local.set({ provider: provider.id });
  hideNotice();
  paintProvider();
  loadFrame();
});
pseg.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const ids = Object.keys(ASK_PROVIDERS), n = ids.indexOf(provider.id) + (e.key === 'ArrowRight' ? 1 : -1);
  const next = pseg.querySelector(`[data-p="${ids[(n + ids.length) % ids.length]}"]`);
  next.click(); next.focus();
});

window.addEventListener('message', (event) => {
  if (event.origin !== provider.origin || event.source !== frame.contentWindow) return;
  const d = event.data;
  if (!d || typeof d.type !== 'string') return;
  if (d.type === 'ask-deepseek-ready') {
    ready = true;
    clearTimeout(readyTimer);
    if (!popupOpen) hideNotice();
    flush();
  } else if (d.type === 'ask-deepseek-result' && d.ok !== false) {
    try { window.focus(); frame.focus(); } catch {}
  } else if (d.type === 'ask-deepseek-result' && d.ok === false) {
    showToast(d.reason === 'input-not-found'
      ? "Couldn't find " + pname() + "'s message box (signed in? see selectors.js)."
      : 'Could not add text to ' + pname() + '.');
  }
});

function post(payload) {
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
const stripHint = document.getElementById('stripHint');
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
  stripHint.textContent = reader ? 'PDF reader has its own tools' : '';
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
