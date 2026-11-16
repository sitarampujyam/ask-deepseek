// Ask LLM: service worker.
// Responsibilities: side-panel behaviour, header-stripping rule, PDF interception,
// context menu, open/closed tracking of the side panel, routing selections.

importScripts('providers.js');

async function providerUrl() {
  const { provider } = await chrome.storage.local.get({ provider: ASK_DEFAULT_PROVIDER });
  return (ASK_PROVIDERS[provider] || ASK_PROVIDERS[ASK_DEFAULT_PROVIDER]).url;
}
const MAX_CHARS = 6000;

const panels = new Map();       // windowId -> { port }
const pending = new Map();      // windowId -> payloads waiting for the panel to finish opening
const popups = new Map();       // main windowId -> { tabId, windowId, queue: [] }

let interceptPdfs = true;

/* ---------- setup ---------- */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// DNR can only remove a response header, not edit part of it, so for the chat frames
// (DeepSeek, Claude) loaded by THIS extension we drop X-Frame-Options and the whole CSP header.
async function installRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' }
        ]
      },
      condition: {
        requestDomains: Object.values(ASK_PROVIDERS).map(p => new URL(p.origin).hostname),
        resourceTypes: ['sub_frame'],
        initiatorDomains: [chrome.runtime.id]
      }
    }]
  });
}
installRules().catch(console.error);

function installMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-in-reader', title: 'Open in Ask LLM reader', contexts: ['link', 'page'] });
  });
}
chrome.runtime.onInstalled.addListener(() => { installRules().catch(console.error); installMenu(); });

chrome.storage.local.get({ interceptPdfs: true }).then(v => { interceptPdfs = v.interceptPdfs; });

// Toolbar icon takes the reader's colour theme (icons/tint/<colour>-16/32.png).
const TINTS = ['violet', 'magenta', 'rose', 'amber', 'emerald', 'teal', 'ocean'];
function tintIcon(id) {
  const t = TINTS.includes(id) ? id : 'violet';
  chrome.action.setIcon({ path: { 16: `icons/tint/${t}-16.png`, 32: `icons/tint/${t}-32.png` } }).catch(() => {});
}
chrome.storage.local.get({ hue: 'violet' }).then(v => tintIcon(v.hue));
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.hue) tintIcon(ch.hue.newValue); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.interceptPdfs) interceptPdfs = changes.interceptPdfs.newValue !== false;
});

/* ---------- PDF interception ---------- */

function viewerUrl(fileUrl) {
  return chrome.runtime.getURL('viewer.html') + '?file=' + encodeURIComponent(fileUrl);
}

function isPdfPath(urlString) {
  try {
    const u = new URL(urlString);
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) return false;
    return u.pathname.toLowerCase().endsWith('.pdf');
  } catch { return false; }
}

// '#__noask' (added by the reader's "Open in Chrome's viewer") skips interception once.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0 || !interceptPdfs || d.url.includes('__noask') || !isPdfPath(d.url)) return;
  chrome.tabs.update(d.tabId, { url: viewerUrl(d.url) }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'open-in-reader') return;
  const target = info.linkUrl || info.pageUrl;
  if (!target) return;
  if (info.linkUrl) chrome.tabs.create({ url: viewerUrl(target), index: tab ? tab.index + 1 : undefined });
  else if (tab) chrome.tabs.update(tab.id, { url: viewerUrl(target) });
});

/* ---------- open-state tracking ---------- */

// Tell every page (content script) in that window whether the side panel is open.
async function broadcastPanelState(windowId) {
  const open = panels.has(windowId);
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'panel-state', open }).catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    let winId = null;
    port.onMessage.addListener((msg) => {
      if (msg.type === 'hello' && typeof msg.windowId === 'number') {
        winId = msg.windowId;
        panels.set(winId, { port });
        broadcastPanelState(winId);
        for (const payload of pending.get(winId) || []) port.postMessage({ type: 'deliver', payload });
        pending.delete(winId);
        if (popups.has(winId)) port.postMessage({ type: 'popup-state', open: true });
      }
      // 'ping' only exists to keep the service worker alive.
    });
    port.onDisconnect.addListener(() => {
      const st = panels.get(winId);
      if (st && st.port === port) { panels.delete(winId); broadcastPanelState(winId); }
    });
  }
});

/* ---------- routing ---------- */

function sanitize(p) {
  if (p && p.kind === 'image') {
    if (typeof p.dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(p.dataUrl) || p.dataUrl.length > 14e6) return null;
    return { kind: 'image', dataUrl: p.dataUrl, title: String(p.title || 'PDF').slice(0, 300), page: String(p.page || '').slice(0, 20) };
  }
  if (!p || typeof p.text !== 'string') return null;
  return {
    text: p.text.slice(0, MAX_CHARS),
    url: typeof p.url === 'string' && /^(https?|file):/.test(p.url) ? p.url.slice(0, 500) : '',
    title: String(p.title || 'PDF').slice(0, 300),
    page: typeof p.page === 'string' || typeof p.page === 'number' ? String(p.page).slice(0, 20) : ''
  };
}

async function deliverToPopup(popup, payload) {
  try {
    const r = await chrome.tabs.sendMessage(popup.tabId, { type: 'prefill', payload }, { frameId: 0 });
    return r || { ok: true };
  } catch {
    popup.queue.push(payload); // content script not ready yet, flushed on 'cs-ready'
    return { ok: true, queued: true };
  }
}

// Open if the panel holds a live port, or (authoritative fallback) a side-panel page exists in that window.
async function isPanelOpen(windowId) {
  if (typeof windowId !== 'number') return false;
  if (panels.has(windowId)) return true;
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return ctxs.some(c => c.windowId === windowId);
  } catch { return false; }
}

async function handleAsk(msg, sender) {
  const winId = sender.tab ? sender.tab.windowId : undefined;
  const payload = sanitize(msg.payload);
  if (!payload || (payload.kind !== 'image' && !payload.text)) return { ok: false, reason: 'empty' };
  const panel = panels.get(winId);
  const popup = popups.get(winId);
  if (!panel) {
    // No live connection from the panel: either it is still starting (the reader just opened it) or it is closed.
    if (!(await isPanelOpen(winId)) && !msg.queueIfClosed) return { ok: false, reason: 'panel-closed' };
    // Hold the text until the panel says hello (it flushes `pending`). Works even if the panel is mid-startup.
    const q = pending.get(winId) || [];
    q.push(payload); pending.set(winId, q.slice(-5));
    setTimeout(() => pending.delete(winId), 30000);
    return { ok: true, queued: true };
  }
  if (popup) return deliverToPopup(popup, payload);
  panel.port.postMessage({ type: 'deliver', payload });
  return { ok: true };
}

async function openPopup(mainWindowId) {
  const existing = popups.get(mainWindowId);
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return { ok: true };
  }
  const main = await chrome.windows.get(mainWindowId);
  const startUrl = await providerUrl();
  const width = 440;
  let win;
  try {
    win = await chrome.windows.create({
      url: startUrl,
      type: 'popup',
      width,
      height: main.height,
      left: (main.left || 0) + (main.width || 1200) - width, // docked over the side panel
      top: main.top || 0
    });
  } catch {
    // Bounds rejected (e.g. off-screen on a small/odd display): let Chrome place it.
    try {
      win = await chrome.windows.create({ url: startUrl, type: 'popup', width, height: 700 });
    } catch {
      win = await chrome.windows.create({ url: startUrl, type: 'popup' });
    }
  }
  popups.set(mainWindowId, { tabId: win.tabs[0].id, windowId: win.id, queue: [] });
  notifyPanel(mainWindowId, { type: 'popup-state', open: true });
  return { ok: true };
}

function notifyPanel(winId, msg) {
  const p = panels.get(winId);
  if (p) { try { p.port.postMessage(msg); } catch {} }
}

chrome.windows.onRemoved.addListener((closedId) => {
  for (const [mainId, p] of popups) {
    if (p.windowId === closedId) { popups.delete(mainId); notifyPanel(mainId, { type: 'popup-state', open: false }); }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'get-panel-state') {
    isPanelOpen(sender.tab && sender.tab.windowId).then(open => sendResponse({ open }));
    return true;
  }
  if (msg.type === 'ask-selection') {
    handleAsk(msg, sender).then(sendResponse).catch(e => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg.type === 'open-popup' && typeof msg.windowId === 'number') {
    openPopup(msg.windowId).then(sendResponse).catch(e => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg.type === 'close-popup' && typeof msg.windowId === 'number') {
    const p = popups.get(msg.windowId);
    if (p) chrome.windows.remove(p.windowId).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'focus-popup' && typeof msg.windowId === 'number') {
    const p = popups.get(msg.windowId);
    if (p) chrome.windows.update(p.windowId, { focused: true }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'cs-ready' && sender.tab) {
    for (const p of popups.values()) {
      if (p.tabId === sender.tab.id && p.queue.length) {
        const q = p.queue.splice(0);
        q.forEach(payload => chrome.tabs.sendMessage(p.tabId, { type: 'prefill', payload }, { frameId: 0 }).catch(() => {}));
      }
    }
    sendResponse({ ok: true });
  }
});

// Keyboard shortcut (Option+D on Mac): open the side panel, or close it if it is already open.
// sidePanel.open() needs the keypress's user gesture, so it must be called synchronously: no `await` before it.
function togglePanel(windowId) {
  const open = panels.get(windowId);
  if (!open) return chrome.sidePanel.open({ windowId }).then(() => 'opened');
  try { open.port.postMessage({ type: 'close' }); } catch {}          // the panel page closes itself
  if (chrome.sidePanel.close) chrome.sidePanel.close({ windowId }).catch(() => {});
  panels.delete(windowId); broadcastPanelState(windowId);              // forget it now so the next press opens
  return Promise.resolve('closed');
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-panel' && tab) togglePanel(tab.windowId).catch(console.error);
});
