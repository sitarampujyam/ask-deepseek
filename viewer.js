import * as pdfjsLib from './lib/pdf.min.mjs';

const { AnnotationEditorType: ET, AnnotationEditorParamsType: PT, AnnotationEditorUIManager, AnnotationEditorLayer, DrawLayer } = pdfjsLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
const container = $('container');
const pagesEl = $('pages');
const thumbsEl = $('thumbs');
const pageInput = $('pageInput');
const zoomInput = $('zoomInput');
const CSS_UNITS = 96 / 72;                 // so "100%" matches Chrome's 100%
const MIN_ZOOM = 0.25, MAX_ZOOM = 5;
const SB_TOTAL = 196 + 14;                 // sidebar width + gap (keep in sync with viewer.css)
const RENDER_MARGIN = 1200;            // px above/below the view that get pre-rendered
const THUMB_W = 132;
const MODES = ['normal', 'dark', 'sepia'];
const MODE_LABEL = { normal: 'Original', dark: 'Dark', sepia: 'Sepia' };

let pdf = null, pages = [], thumbs = [];
let fileSize = 0, originalUrl = '', fileName = 'document.pdf', sourceTitle = 'PDF';
let rotation = 0, twoPage = false, annotsOn = true;
let zoomMode = 'fit-width';                // 'fit-width' | 'fit-page' | 'custom'
let scale = 1;
let sidebarOpen = false;
let mode = 'normal';
let present = false, presentBackup = null;

/* ---------- prefs ---------- */
const pref = {
  get(k, d) { try { const v = localStorage.getItem('askds.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('askds.' + k, JSON.stringify(v)); } catch {} }
};

/* ---------- small helpers ---------- */
let toastT = 0;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1300);
}
function showMessage(html) { const m = $('message'); m.innerHTML = html; m.hidden = false; }
function filenameFromUrl(u) {
  try {
    const last = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '');
    return last || 'document.pdf';
  } catch { return 'document.pdf'; }
}

// Specular sheen follows the pointer on every glass surface.
document.addEventListener('pointermove', (e) => {
  const g = e.target.closest && e.target.closest('.glass');
  if (!g) return;
  const r = g.getBoundingClientRect();
  g.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
  g.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
});
// Optional refraction: only where the browser accepts url() in backdrop-filter.
if (window.CSS && CSS.supports && CSS.supports('backdrop-filter', 'url(#glass-refract) blur(1px)')) {
  document.querySelectorAll('#toolbar, #sidebar, #menu').forEach(el => el.classList.add('refract'));
}

/* ---------- loading ---------- */
const params = new URLSearchParams(location.search);
const fileUrl = (params.get('file') || '').trim();
const DOC_OPTS = {
  cMapUrl: chrome.runtime.getURL('lib/cmaps/'), cMapPacked: true,
  standardFontDataUrl: chrome.runtime.getURL('lib/standard_fonts/'),
  isEvalSupported: false,            // extension CSP forbids eval anyway; skip the failed attempt
  enableHWA: true                    // GPU-accelerated canvases
};

const progressEl = $('progress');
function setProgress(f) {
  if (f === null || f >= 1) { progressEl.hidden = true; return; }
  progressEl.hidden = false; progressEl.style.setProperty('--p', Math.max(.04, f).toFixed(3));
}

let passwordCancelled = false;
function wire(task) {
  task.onProgress = ({ loaded, total }) => { if (total) setProgress(loaded / total); };
  task.onPassword = (update, reason) => {
    askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then(pw => {
      if (pw === null) { passwordCancelled = true; task.destroy(); } else update(pw);
    });
  };
  return task;
}

// 1) Stream with range requests, so page 1 shows before the whole file has arrived.
// 2) If the server misbehaves with that, fall back to downloading the whole file once.
async function openDocument() {
  try {
    return await wire(pdfjsLib.getDocument({ ...DOC_OPTS, url: originalUrl, withCredentials: true })).promise;
  } catch (e) {
    if (passwordCancelled || (e && (e.name === 'PasswordException' || e.name === 'InvalidPDFException'))) throw e;
    const res = await fetch(originalUrl, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.arrayBuffer();
    return await wire(pdfjsLib.getDocument({ ...DOC_OPTS, data })).promise;
  }
}

async function load() {
  originalUrl = fileUrl.split('#')[0];
  fileName = filenameFromUrl(originalUrl);
  sourceTitle = fileName.replace(/\.pdf$/i, '');
  $('title').textContent = fileName; $('title').title = fileName;
  document.title = fileName + ' | Ask DeepSeek reader';
  if (!fileUrl) return showMessage('No PDF given.<br>Open a PDF link, or right-click a link → <b>Open in Ask DeepSeek reader</b>.');
  const startPage = (/#.*?page=(\d+)/i.exec(fileUrl) || [])[1] | 0 || 1;

  setProgress(0);
  try {
    pdf = await openDocument();
  } catch (e) {
    setProgress(null);
    if (passwordCancelled) return showMessage('This PDF is password-protected.');
    if (e && e.name === 'InvalidPDFException') {
      return showMessage('This link didn’t return a PDF (it may need you to sign in first).<br><br><a class="pill inline" id="openNative" href="#">Open in Chrome’s viewer</a>');
    }
    return showMessage(`Could not read the PDF (${String(e && e.message || e)}).` + (originalUrl.startsWith('file:')
      ? '<br><br>For local files, enable <b>Allow access to file URLs</b> for this extension at <code>chrome://extensions</code>.' : ''));
  }
  initEditor();
  pdf.getDownloadInfo().then(i => { fileSize = i.length; }).catch(() => {});
  pdf.getMetadata().then(meta => {
    const t = meta && meta.info && typeof meta.info.Title === 'string' ? meta.info.Title.trim() : '';
    if (t) sourceTitle = t;
  }).catch(() => {});

  $('pageCount').textContent = '/ ' + pdf.numPages;
  // Where you stopped last time (unless the link names a page itself, or you turned this off in Options).
  try { rememberOn = (await chrome.storage.local.get({ rememberPosition: true })).rememberPosition !== false; } catch {}
  const resume = rememberOn && !/#.*?page=\d+/i.test(fileUrl) ? readPos() : null;
  if (resume) {
    rotation = [0, 90, 180, 270].includes(resume.r) ? resume.r : 0;
    twoPage = !!resume.two; $('miTwoPage').setAttribute('aria-checked', String(twoPage));
    if (resume.zm === 'custom' && resume.z > 0) { zoomMode = 'custom'; scale = clamp(resume.z, MIN_ZOOM, MAX_ZOOM) * CSS_UNITS; }
    else if (resume.zm === 'fit-page') zoomMode = 'fit-page';
  }
  await buildPages();
  buildThumbs();
  applyLayout({ initial: true, keepScale: zoomMode === 'custom' });
  syncFitButton();
  if (resume) { const t = getTops()[clamp(resume.page, 1, pages.length) - 1]; container.scrollTop = t + (resume.f || 0) * pages[clamp(resume.page, 1, pages.length) - 1].div.offsetHeight; update(); }
  else if (startPage > 1) goToPage(startPage);
  posReady = true;
  window.__viewerReady = true;
  fillPageSizes();
}
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'openNative') { e.preventDefault(); location.href = originalUrl + '#__noask'; }
});

/* ---------- pages ---------- */
// Lay out every page right away using page 1's size; real sizes arrive in the background (fillPageSizes).
async function buildPages() {
  const first = await pdf.getPage(1);
  const base = baseDims(first);
  const frag = document.createDocumentFragment();
  pages = Array.from({ length: pdf.numPages }, (_, i) => {
    const div = document.createElement('div');
    div.className = 'pdf-page'; div.dataset.page = String(i + 1);
    frag.appendChild(div);
    return { num: i + 1, div, proxy: i === 0 ? first : null, base: i === 0 ? base : base.slice(), w: 1, h: 1,
      state: 'idle', key: null, token: 0, task: null, fails: 0 };
  });
  pagesEl.replaceChildren(frag);
  measure();
}

// Size at scale 1, including the page's own /Rotate.
function baseDims(proxy) { const v = proxy.getViewport({ scale: 1 }); return [v.width, v.height]; }
const pageRotation = (p) => ((p.proxy ? p.proxy.rotate : 0) + rotation) % 360;

// Apply the user's rotation on top of each page's own size.
function measure() {
  for (const p of pages) { const [bw, bh] = p.base; [p.w, p.h] = rotation % 180 ? [bh, bw] : [bw, bh]; }
}

function setBase(p, proxy) {
  p.proxy = proxy;
  const b = baseDims(proxy);
  const changed = Math.abs(b[0] - p.base[0]) > .5 || Math.abs(b[1] - p.base[1]) > .5;
  p.base = b;
  return changed;
}

let relayoutT = 0;
function relayoutSoon() { clearTimeout(relayoutT); relayoutT = setTimeout(() => { measure(); applyLayout({ keepScale: zoomMode === 'custom' }); sizeThumbs(); if (active === 0) pumpThumbs(); }, 60); }

// Fetch the remaining pages' real sizes in small batches while the reader is idle.
async function fillPageSizes() {
  const doc = pdf;
  for (let i = 1; i < pages.length; i += 16) {
    await new Promise(r => (window.requestIdleCallback || setTimeout)(r, { timeout: 400 }));
    if (doc !== pdf) return;
    const batch = pages.slice(i, i + 16).filter(p => !p.proxy);
    const proxies = await Promise.all(batch.map(p => pdf.getPage(p.num).catch(() => null)));
    let changed = false;
    batch.forEach((p, k) => { if (proxies[k] && !p.proxy && setBase(p, proxies[k])) changed = true; });
    if (changed) relayoutSoon();
  }
}

/* ---------- layout & zoom ---------- */
function availWidth() { return container.clientWidth - 36 - (sidebarOpen && !present ? SB_TOTAL : 0); }
function availHeight() { return container.clientHeight - (present ? 0 : 76 + 30); }

function fitScale(kind) {
  const cols = twoPage && !present ? 2 : 1, gap = present ? 0 : 14;
  let maxW = 0, maxH = 0;
  for (const p of pages) { if (p.w > maxW) maxW = p.w; if (p.h > maxH) maxH = p.h; }
  let s = (availWidth() - gap * (cols - 1)) / (cols * maxW);
  if (kind === 'fit-page') s = Math.min(s, (availHeight() - (present ? 0 : 4)) / maxH);
  return clamp(s, MIN_ZOOM * CSS_UNITS, MAX_ZOOM * CSS_UNITS);
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Cached page offsets (one layout read per change, binary search per scroll frame).
let tops = null;
function getTops() { if (!tops) tops = pages.map(p => p.div.offsetTop); return tops; }
function firstIndexBelow(y) {          // first page whose bottom edge is below y
  const t = getTops(); let lo = 0, hi = pages.length - 1, ans = pages.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] + pages[m].div.offsetHeight > y) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans;
}
function rangeFor(y0, y1) {            // [lo, hi] indices of pages overlapping y0..y1
  const lo = Math.max(0, firstIndexBelow(y0) - 1), t = getTops(); let hi = lo;
  while (hi + 1 < pages.length && t[hi + 1] < y1) hi++;
  return [lo, hi];
}

function sizePages() {
  pagesEl.style.setProperty('--cols', twoPage && !present ? 2 : 1);
  for (const p of pages) {
    p.div.style.width = Math.floor(p.w * scale) + 'px';
    p.div.style.height = Math.floor(p.h * scale) + 'px';
    p.div.style.setProperty('--scale-factor', String(scale));
  }
  tops = null;
  updateZoomUi();
}

function currentKey() { return scale.toFixed(4) + '|' + rotation + '|' + (window.devicePixelRatio || 1); }

// Re-compute scale from zoomMode (or keep it), re-size pages, keep the reading position (anchored to a page).
function applyLayout({ initial = false, keepScale = false, hard = false, defer = false } = {}) {
  let anchor = null;
  if (!initial && pages.length) {
    const a = pages[currentPage() - 1];
    anchor = { p: a, f: (container.scrollTop - getTops()[a.num - 1]) / Math.max(1, a.div.offsetHeight) };
  }
  const rx = container.scrollLeft + container.clientWidth / 2, rw = Math.max(1, container.scrollWidth);
  if (!keepScale) scale = zoomMode === 'custom' ? scale : fitScale(zoomMode);
  if (hard) [...live].forEach(unrender);
  sizePages();
  syncEditorView();
  if (anchor) {
    container.scrollTop = getTops()[anchor.p.num - 1] + anchor.f * anchor.p.div.offsetHeight;
    container.scrollLeft = (rx / rw) * container.scrollWidth - container.clientWidth / 2;
  }
  if (defer) scheduleUpdate(); else update();
}

function setZoom(z, { defer = false } = {}) {   // z is in "Chrome percent" units (1 = 100%)
  zoomMode = 'custom';
  scale = clamp(z, MIN_ZOOM, MAX_ZOOM) * CSS_UNITS;
  applyLayout({ keepScale: true, defer });
  syncFitButton();
}
const curZoom = () => scale / CSS_UNITS;
const ZOOM_STEPS = [.25, .33, .5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
function stepZoom(dir) {
  const z = curZoom();
  const next = dir > 0 ? ZOOM_STEPS.find(s => s > z + .005) : [...ZOOM_STEPS].reverse().find(s => s < z - .005);
  if (next) setZoom(next);
}
function updateZoomUi() { if (document.activeElement !== zoomInput) zoomInput.value = Math.round(curZoom() * 100) + '%'; }

function syncFitButton() {
  const toPage = zoomMode !== 'fit-page';       // the button shows what a click will do
  $('icoFitPage').toggleAttribute('hidden', !toPage); $('icoFitWidth').toggleAttribute('hidden', toPage);
  const label = toPage ? 'Fit to page' : 'Fit to width';
  $('btnFit').setAttribute('aria-label', label); $('btnFit').title = label;
}
function toggleFit() {
  zoomMode = zoomMode === 'fit-page' ? 'fit-width' : 'fit-page';
  applyLayout(); syncFitButton();
  if (zoomMode === 'fit-page') goToPage(currentPage());
}

/* ---------- rendering: a small priority queue ---------- */
// Pages in view render first (nearest the centre first), then pages just off-screen. At most MAX_ACTIVE at once,
// so the page you're looking at never waits behind off-screen work. Old canvases stay (stretched) until the
// sharp one is ready, so zooming never flashes white.
const MAX_ACTIVE = 2;
const MAX_CANVAS_PIXELS = 16777216;          // larger canvases can silently fail (blank page) on some GPUs
const live = new Set();                      // pages that currently hold a canvas or are rendering
let active = 0;

function unrender(p) {
  p.token++;
  if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }
  destroyEditor(p);
  if (p.state !== 'idle') p.div.replaceChildren();
  p.state = 'idle'; p.key = null; live.delete(p);
}

const linkService = {
  externalLinkEnabled: true, isInPresentationMode: false, eventBus: null, page: 1, rotation: 0,
  addLinkAttributes(link, url, newWindow) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer nofollow'; },
  getDestinationHash() { return '#'; }, getAnchorUrl() { return '#'; },
  async goToDestination(dest) {
    try {
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) return;
      const idx = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
      goToPage(idx + 1);
    } catch {}
  },
  goToPage(n) { goToPage(n); },
  executeNamedAction(a) {
    if (a === 'NextPage') goToPage(currentPage() + 1); else if (a === 'PrevPage') goToPage(currentPage() - 1);
    else if (a === 'FirstPage') goToPage(1); else if (a === 'LastPage') goToPage(pages.length);
  },
  executeSetOCGState() {}, cachePageRef() {}, getPageNumberFromDest() { return null; }
};

function viewWindow() { const top = container.scrollTop; return { top, bottom: top + container.clientHeight, mid: top + container.clientHeight / 2 }; }

function nextToRender() {
  if (!pages.length) return null;
  const key = currentKey(), v = viewWindow(), t = getTops();
  const [lo, hi] = rangeFor(v.top - RENDER_MARGIN, v.bottom + RENDER_MARGIN);
  let best = null, bestD = Infinity;
  for (let i = lo; i <= hi; i++) {
    const p = pages[i];
    if (p.key === key) continue;                       // done or in flight at this zoom
    const y0 = t[i], y1 = y0 + p.div.offsetHeight;
    const visible = y1 > v.top && y0 < v.bottom;
    const d = Math.abs((y0 + y1) / 2 - v.mid) + (visible ? 0 : 1e6);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function pump() {
  while (active < MAX_ACTIVE) {
    const p = nextToRender();
    if (!p) break;
    active++;
    render(p).finally(() => { active--; pump(); });
  }
  if (active === 0) pumpThumbs();
}

async function render(p) {
  const key = currentKey();
  if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }
  p.key = key; live.add(p);
  const token = ++p.token;
  try {
    if (!p.proxy) {
      const proxy = await pdf.getPage(p.num);
      if (!p.proxy && setBase(p, proxy)) relayoutSoon();
      if (p.token !== token) return;
    }
    const viewport = p.proxy.getViewport({ scale, rotation: pageRotation(p) });
    let dpr = window.devicePixelRatio || 1;
    if (viewport.width * viewport.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr)); canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    const task = p.proxy.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    p.task = task;
    await task.promise;
    p.task = null;
    if (p.token !== token) return;
    const wrap = document.createElement('div'); wrap.className = 'canvasWrapper'; wrap.appendChild(canvas);
    const textDiv = document.createElement('div'); textDiv.className = 'textLayer';
    const annDiv = document.createElement('div'); annDiv.className = 'annotationLayer';
    destroyEditor(p);                                   // editors live in the store and are rebuilt on the new layer
    p.div.replaceChildren(wrap, textDiv, annDiv);       // the picture shows now; text, links and editors follow
    p.state = 'done'; p.fails = 0;
    layers(p, viewport, textDiv, annDiv, token);
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') { if (p.token === token) p.key = null; return; }
    if (p.token !== token) return;
    p.fails++;
    p.key = p.fails >= 3 ? key : null;                   // give up on this zoom level after 3 tries
    if (p.state === 'idle') live.delete(p);
    console.error('render failed', p.num, e);
  }
}

async function layers(p, viewport, textDiv, annDiv, token) {
  try {
    const tl = new pdfjsLib.TextLayer({ textContentSource: p.proxy.streamTextContent(), container: textDiv, viewport });
    await tl.render();
  } catch (e) { if (p.token === token) console.debug('text layer skipped', p.num, e); }
  if (p.token !== token) return;
  mountEditor(p, viewport, textDiv, annDiv);              // highlights, drawings and text boxes sit on top
  try {   // annotations (links etc.) are best-effort; the page works without them
    const annotations = await p.proxy.getAnnotations({ intent: 'display' });
    if (p.token !== token || !annotations.length) return;
    const layer = new pdfjsLib.AnnotationLayer({ div: annDiv, accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, page: p.proxy, viewport: viewport.clone({ dontFlip: true }), structTreeLayer: null });
    await layer.render({ annotations, imageResourcesPath: '', renderForms: false, linkService, downloadManager: null, annotationStorage: pdf.annotationStorage, enableScripting: false, hasJSActions: false, fieldObjectsPromise: null, annotationCanvasMap: null, accessibilityManager: null });
  } catch (e) { console.debug('annotations skipped', e); }
}

let updT = 0;
function scheduleUpdate() { clearTimeout(updT); updT = setTimeout(update, 110); }

function currentPage() {
  if (!pages.length) return 1;
  const probe = container.scrollTop + (present ? container.clientHeight / 2 : 76 + (container.clientHeight - 76) * .3);
  const t = getTops();
  let i = Math.min(pages.length - 1, firstIndexBelow(probe));
  if (t[i] > probe && i > 0) i--;
  while (i > 0 && Math.abs(t[i - 1] - t[i]) < 3) i--;     // two-page rows: report the left page
  return i + 1;
}

let lastCurrent = 0;
function update() {
  if (!pages.length) return;
  const key = currentKey(), v = viewWindow();
  const [lo, hi] = rangeFor(v.top - RENDER_MARGIN * 1.5, v.bottom + RENDER_MARGIN * 1.5);
  for (const p of [...live]) {
    const i = p.num - 1;
    if (i < lo || i > hi) unrender(p);                         // far away: free the memory
    else if (p.task && p.key !== key) { try { p.task.cancel(); } catch {} p.task = null; p.key = null; }
  }
  pump();
  const cur = currentPage();
  if (document.activeElement !== pageInput) pageInput.value = String(cur);
  if (cur !== lastCurrent) { lastCurrent = cur; markThumb(cur); bus.dispatch('pagechanging', { pageNumber: cur }); }
  schedulePos();
}

function goToPage(n, smooth = false) {
  const p = pages[clamp(Math.round(n) || 1, 1, pages.length) - 1];
  if (!p) return;
  const y0 = getTops()[p.num - 1];
  const y = present ? y0 - (container.clientHeight - p.div.offsetHeight) / 2 : y0 - 68;
  container.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' });
}

/* ---------- thumbnails (rendered only when the main pages are idle) ---------- */
let thumbObserver = null;
const thumbWanted = new Set();
let thumbBusy = false;
function buildThumbs() {
  const frag = document.createDocumentFragment();
  thumbs = pages.map((p) => {
    const b = document.createElement('button');
    b.className = 'thumb'; b.dataset.page = String(p.num); b.setAttribute('aria-label', 'Page ' + p.num);
    b.innerHTML = '<div class="thumb-page"></div><span class="num">' + p.num + '</span>';
    b.addEventListener('click', () => goToPage(p.num));
    frag.appendChild(b);
    return { num: p.num, el: b, box: b.firstChild, key: null };
  });
  thumbsEl.replaceChildren(frag);
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const t = thumbs[parseInt(en.target.dataset.page, 10) - 1];
      if (en.isIntersecting) thumbWanted.add(t); else thumbWanted.delete(t);
    }
    if (active === 0) pumpThumbs();
  }, { root: thumbsEl, rootMargin: '400px 0px' });
  thumbs.forEach(t => thumbObserver.observe(t.el));
  sizeThumbs();
}
function sizeThumbs() {
  const rk = 'thumb|' + rotation;
  thumbs.forEach((t, i) => {
    const p = pages[i];
    const h = Math.round(THUMB_W * p.h / p.w);
    t.box.style.width = THUMB_W + 'px';
    t.box.style.height = h + 'px';
    if (t.key && (t.key !== rk || t.h !== h)) { t.box.replaceChildren(); t.key = null; }   // rotated or real size arrived
    t.h = h;
  });
}
async function pumpThumbs() {
  if (thumbBusy || !sidebarOpen || !pdf) return;
  const rk = 'thumb|' + rotation, cur = currentPage();
  let best = null, bestD = Infinity;
  for (const t of thumbWanted) { if (t.key !== rk) { const d = Math.abs(t.num - cur); if (d < bestD) { bestD = d; best = t; } } }
  if (!best) return;
  thumbBusy = true;
  try { await renderThumb(best, rk); } catch {}
  thumbBusy = false;
  if (active === 0) pumpThumbs(); else pump();
}
async function renderThumb(t, rk) {
  const p = pages[t.num - 1];
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(THUMB_W * dpr), h = Math.round(THUMB_W * p.h / p.w * dpr);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const src = p.state === 'done' && p.div.querySelector('canvas');
  if (src) {
    ctx.drawImage(src, 0, 0, w, h);                       // reuse the page we already drew: no extra PDF work
  } else {
    if (!p.proxy) { const proxy = await pdf.getPage(p.num); if (!p.proxy && setBase(p, proxy)) relayoutSoon(); }
    const base = p.proxy.getViewport({ scale: 1, rotation: pageRotation(p) });
    await p.proxy.render({ canvasContext: ctx, viewport: p.proxy.getViewport({ scale: w / base.width, rotation: pageRotation(p) }) }).promise;
  }
  t.box.replaceChildren(canvas); t.key = rk;
}
function markThumb(n) {
  thumbs.forEach(t => t.el.classList.toggle('current', t.num === n));
  const t = thumbs[n - 1];
  if (t && sidebarOpen) { const c = t.el.offsetTop - thumbsEl.clientHeight / 2 + t.el.offsetHeight / 2; thumbsEl.scrollTo({ top: c, behavior: 'smooth' }); }
}

function setSidebar(open) {
  sidebarOpen = open; pref.set('sidebar', open);
  document.body.classList.toggle('sb-open', open);
  $('btnSidebar').setAttribute('aria-pressed', String(open));
  if (pages.length) { applyLayout({ defer: false }); markThumb(currentPage()); }
}

/* ---------- password ---------- */
function askPassword(wrong) {
  return new Promise((resolve) => {
    const ov = $('pwd'), input = $('pwdInput');
    $('pwdMsg').textContent = wrong ? 'That password didn’t work. Try again.' : 'This PDF is protected. Enter its password to open it.';
    input.value = ''; ov.hidden = false; input.focus();
    const done = (v) => { ov.hidden = true; $('pwdForm').onsubmit = null; $('pwdCancel').onclick = null; resolve(v); };
    $('pwdForm').onsubmit = (e) => { e.preventDefault(); done(input.value); };
    $('pwdCancel').onclick = () => done(null);
  });
}

/* ---------- colour modes ---------- */
function setMode(m, announce) {
  mode = m; pref.set('mode', m);
  document.body.dataset.mode = m;
  document.querySelectorAll('.mode-ico').forEach(i => i.toggleAttribute('hidden', i.dataset.for !== m));
  const label = 'Page colour: ' + MODE_LABEL[m];
  $('btnMode').setAttribute('aria-label', label); $('btnMode').title = label + ' (click to cycle)';
  if (announce) toast(MODE_LABEL[m]);
}

/* ---------- rotate / two-page / annotations ---------- */
function rotate() {
  rotation = (rotation + 270) % 360;     // counterclockwise
  measure(); applyLayout({ hard: true }); sizeThumbs(); pumpThumbs();
  toast('Rotated ' + ((360 - rotation) % 360) + '° ↺');
}
function setTwoPage(v) {
  twoPage = v; $('miTwoPage').setAttribute('aria-checked', String(v));
  applyLayout({ hard: false });
}
function setAnnots(v) {
  annotsOn = v; pref.set('annots', v); $('miAnnots').setAttribute('aria-checked', String(v));
  document.body.classList.toggle('no-annots', !v);
}

/* ---------- theme: light / dark / system ---------- */
const THEMES = ['light', 'dark', 'system'];
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let theme = 'system';
function applyTheme() {
  const effective = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme;
  document.documentElement.classList.toggle('light', effective === 'light');
  $('seg').style.setProperty('--i', THEMES.indexOf(theme));
  $('seg').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === theme)));
}
function setTheme(t) { theme = t; pref.set('theme', t); applyTheme(); }
$('seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTheme(b.dataset.theme); });
$('seg').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault(); const n = THEMES.indexOf(theme) + (e.key === 'ArrowRight' ? 1 : -1);
  setTheme(THEMES[(n + 3) % 3]); $('seg').querySelector('[aria-checked="true"]').focus();
});
systemDark.addEventListener('change', () => { if (theme === 'system') applyTheme(); });   // follow the OS live

/* ---------- colour accent: shifts every violet tint in the stylesheet by a hue offset (--hs) ---------- */
const HUES = [
  { id: 'violet', name: 'Violet', hs: 0 }, { id: 'magenta', name: 'Magenta', hs: 50 }, { id: 'rose', name: 'Rose', hs: 90 },
  { id: 'amber', name: 'Amber', hs: 150 }, { id: 'emerald', name: 'Emerald', hs: -105 }, { id: 'teal', name: 'Teal', hs: -75 },
  { id: 'ocean', name: 'Ocean', hs: -40 }
];
let hue = 'violet';
const huesEl = $('hues');
HUES.forEach((h) => {
  const b = document.createElement('button');
  b.className = 'hue'; b.setAttribute('role', 'radio'); b.dataset.hue = h.id; b.title = h.name; b.setAttribute('aria-label', h.name);
  b.style.setProperty('--c', `hsl(${250 + h.hs} 78% 62%)`);
  huesEl.appendChild(b);
});
function applyHue() {
  const h = HUES.find(x => x.id === hue) || HUES[0];
  document.documentElement.style.setProperty('--hs', h.hs + 'deg');
  huesEl.querySelectorAll('.hue').forEach(b => b.setAttribute('aria-checked', String(b.dataset.hue === h.id)));
}
huesEl.addEventListener('click', (e) => { const b = e.target.closest('.hue'); if (b) { hue = b.dataset.hue; pref.set('hue', hue); applyHue(); } });
huesEl.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const n = HUES.findIndex(x => x.id === hue) + (e.key === 'ArrowRight' ? 1 : -1);
  hue = HUES[(n + HUES.length) % HUES.length].id; pref.set('hue', hue); applyHue();
  huesEl.querySelector('[aria-checked="true"]').focus();
});

/* ---------- snapshot of the visible PDF area -> DeepSeek ---------- */
let panelOpen = false, myWindowId = null;
chrome.windows.getCurrent().then(w => { myWindowId = w.id; }).catch(() => {});
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'panel-state') panelOpen = !!m.open; });
chrome.runtime.sendMessage({ type: 'get-panel-state' }).then(r => { panelOpen = !!(r && r.open); }).catch(() => {});

const MODE_PAPER = { normal: '#ffffff', dark: '#181a1f', sepia: '#f0e1c2' };
// Composite only the visible parts of the rendered page canvases (no toolbar, no tiles), in the current colour mode.
// A copy of the page canvas with the user's marks drawn into it (they live in the editor layer, not on the canvas).
async function marksCanvas(p, cv) {
  const vp = p.proxy.getViewport({ scale, rotation: pageRotation(p) }), k = cv.width / vp.width;
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
  await p.proxy.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp, transform: [k, 0, 0, k, 0, 0], annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
  return c;
}
async function captureVisible() {
  if (uiManager) uiManager.commitOrRemove();
  const tb = $('toolbar').getBoundingClientRect();
  const clip = { l: sidebarOpen && !present ? SB_TOTAL : 0, t: present ? 0 : Math.ceil(tb.bottom), r: innerWidth, b: innerHeight };
  const key = currentKey(), parts = [];
  for (const p of pages) {
    const r = p.div.getBoundingClientRect();
    const l = Math.max(r.left, clip.l), t = Math.max(r.top, clip.t), rr = Math.min(r.right, clip.r), bb = Math.min(r.bottom, clip.b);
    const cv = p.div.querySelector('canvas');
    if (rr - l < 4 || bb - t < 4 || !cv || p.state !== 'done' || p.key !== key) continue;
    parts.push({ p, r, l, t, rr, bb, cv });
  }
  if (!parts.length) return null;
  if (hasEdits()) for (const x of parts) { try { x.cv = await marksCanvas(x.p, x.cv); } catch (e) { console.debug('marks skipped', e); } }
  const bx = Math.min(...parts.map(x => x.l)), by = Math.min(...parts.map(x => x.t));
  const bx2 = Math.max(...parts.map(x => x.rr)), by2 = Math.max(...parts.map(x => x.bb));
  let k = parts[0].cv.width / parts[0].r.width;
  if ((bx2 - bx) * k > 2400) k = 2400 / (bx2 - bx);              // keep the image a sensible size
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round((bx2 - bx) * k)); out.height = Math.max(1, Math.round((by2 - by) * k));
  const ctx = out.getContext('2d');
  ctx.fillStyle = MODE_PAPER[mode]; ctx.fillRect(0, 0, out.width, out.height);
  for (const x of parts) {
    const kk = x.cv.width / x.r.width;
    const dx = (x.l - bx) * k, dy = (x.t - by) * k, dw = (x.rr - x.l) * k, dh = (x.bb - x.t) * k;
    ctx.save();
    ctx.fillStyle = MODE_PAPER[mode]; ctx.fillRect(dx, dy, dw, dh);
    if (mode === 'dark') ctx.filter = 'invert(.9) hue-rotate(180deg) brightness(1.02)';
    else if (mode === 'sepia') { ctx.filter = 'sepia(.28) contrast(.96)'; ctx.globalCompositeOperation = 'multiply'; }
    ctx.drawImage(x.cv, (x.l - x.r.left) * kk, (x.t - x.r.top) * kk, (x.rr - x.l) * kk, (x.bb - x.t) * kk, dx, dy, dw, dh);
    ctx.restore();
  }
  return new Promise(res => out.toBlob(res, 'image/png'));
}
const blobToDataUrl = (b) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });

$('btnSnap').addEventListener('click', async () => {
  if (!pdf) return;
  // Opening the panel must start inside the click.
  const opening = !panelOpen && myWindowId !== null ? chrome.sidePanel.open({ windowId: myWindowId }).then(() => true, () => false) : null;
  const blob = await captureVisible();
  if (!blob) { toast('Nothing to capture yet'); return; }
  const res = await chrome.runtime.sendMessage({ type: 'ask-selection', queueIfClosed: !panelOpen,
    payload: { kind: 'image', dataUrl: await blobToDataUrl(blob), title: sourceTitle, page: String(currentPage()) } }).catch(() => null);
  if (opening && !(await opening)) return toast('Open the DeepSeek panel first');
  toast(res && res.ok ? 'Snapshot added to DeepSeek' : 'Could not add the snapshot');
});

/* ---------- menu ---------- */
const menu = $('menu'), btnMore = $('btnMore');
function setMenu(open) {
  if (open) { const r = btnMore.getBoundingClientRect(); menu.style.right = Math.max(8, innerWidth - r.right) + 'px'; menu.style.top = (r.bottom + 10) + 'px'; }
  menu.hidden = !open; btnMore.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('.item').focus({ preventScroll: true });
}
btnMore.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
$('miTwoPage').addEventListener('click', () => { setTwoPage(!twoPage); setMenu(false); });
$('miAnnots').addEventListener('click', () => { setAnnots(!annotsOn); setMenu(false); });
$('miPresent').addEventListener('click', () => { setMenu(false); startPresent(); });
$('miProps').addEventListener('click', () => { setMenu(false); showProps(); });
$('miNative').addEventListener('click', () => { location.href = originalUrl + (originalUrl.includes('#') ? '&' : '#') + '__noask'; });
menu.addEventListener('keydown', (e) => {
  const items = [...menu.querySelectorAll('.item')]; const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});

/* ---------- document properties ---------- */
function pdfDate(s) {
  const m = /^D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?/.exec(s || '');
  if (!m) return s || '–';
  const d = new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function pageSizeLabel(proxy) {
  const v = proxy.getViewport({ scale: 1, rotation: 0 });
  const mm = [v.width / 72 * 25.4, v.height / 72 * 25.4].sort((a, b) => a - b);
  const near = (a, b) => Math.abs(a - b) < 3;
  let name = '';
  if (near(mm[0], 210) && near(mm[1], 297)) name = ' (A4)'; else if (near(mm[0], 215.9) && near(mm[1], 279.4)) name = ' (Letter)';
  else if (near(mm[0], 148) && near(mm[1], 210)) name = ' (A5)'; else if (near(mm[0], 297) && near(mm[1], 420)) name = ' (A3)';
  return `${(v.width / 72 * 25.4).toFixed(0)} × ${(v.height / 72 * 25.4).toFixed(0)} mm${name}`;
}
async function showProps() {
  if (!pdf) return;
  let info = {}; try { info = (await pdf.getMetadata()).info || {}; } catch {}
  const rows = [
    ['File name', fileName], ['File size', fmtSize(fileSize)], ['Title', info.Title || '–'], ['Author', info.Author || '–'],
    ['Subject', info.Subject || '–'], ['Keywords', info.Keywords || '–'], ['Created', pdfDate(info.CreationDate)], ['Modified', pdfDate(info.ModDate)],
    ['Application', info.Creator || '–'], ['PDF producer', info.Producer || '–'], ['PDF version', info.PDFFormatVersion || '–'],
    ['Page count', String(pdf.numPages)], ['Page size', pageSizeLabel(pages[0].proxy)]
  ];
  const dl = $('propsList'); dl.replaceChildren();
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
  $('props').hidden = false; $('propsClose').focus();
}
$('propsClose').addEventListener('click', () => { $('props').hidden = true; });
$('props').addEventListener('click', (e) => { if (e.target === $('props')) $('props').hidden = true; });

/* ---------- print ---------- */
$('btnPrint').addEventListener('click', async () => {
  if (!pdf) return;
  toast('Preparing to print…');
  const pc = $('printContainer'); pc.replaceChildren();
  const urls = [];
  const first = pages[0].proxy.getViewport({ scale: 1 });
  let style = document.getElementById('printPageStyle');
  if (!style) { style = document.createElement('style'); style.id = 'printPageStyle'; document.head.appendChild(style); }
  style.textContent = `@page { size: ${first.width}pt ${first.height}pt; margin: 0; }`;
  for (const p of pages) {
    if (!p.proxy) setBase(p, await pdf.getPage(p.num));
    const vp = p.proxy.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await p.proxy.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;   // includes your marks
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .92));
    const img = new Image(); const u = URL.createObjectURL(blob); urls.push(u); img.src = u; await img.decode().catch(() => {});
    pc.appendChild(img);
  }
  const done = () => { pc.replaceChildren(); urls.forEach(URL.revokeObjectURL); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
});

/* ---------- present ---------- */
async function startPresent() {
  if (!pdf || present) return;
  try { await document.documentElement.requestFullscreen(); } catch { toast('Fullscreen unavailable'); return; }
}
function enterPresent() {
  if (present) return;
  if (barOpen) setBar(false);
  present = true; presentBackup = { zoomMode, scale, twoPage };
  document.body.classList.add('present');
  twoPage = false; zoomMode = 'fit-page';
  applyLayout({ hard: true }); goToPage(currentPage());
}
function exitPresent() {
  if (!present) return;
  present = false; document.body.classList.remove('present');
  ({ zoomMode, scale, twoPage } = presentBackup);
  applyLayout({ keepScale: zoomMode === 'custom', hard: true }); syncFitButton();
}
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) enterPresent(); else exitPresent(); });

/* ---------- controls ---------- */
let raf = 0;
container.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); }, { passive: true });
$('btnSidebar').addEventListener('click', () => setSidebar(!sidebarOpen));
$('zoomIn').addEventListener('click', () => stepZoom(1));
$('zoomOut').addEventListener('click', () => stepZoom(-1));
$('btnFit').addEventListener('click', toggleFit);
$('btnRotate').addEventListener('click', rotate);
$('btnMode').addEventListener('click', () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length], true));

function commitPage() { const n = parseInt(pageInput.value, 10); if (n) goToPage(n); pageInput.value = String(currentPage()); }
pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitPage(); pageInput.blur(); } e.stopPropagation(); });
pageInput.addEventListener('change', commitPage);
pageInput.addEventListener('focus', () => pageInput.select());
function commitZoom() { const v = parseFloat(zoomInput.value.replace('%', '')); if (v > 0) setZoom(v / 100); updateZoomUi(); }
zoomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitZoom(); zoomInput.blur(); } e.stopPropagation(); });
let zoomBefore = '';
zoomInput.addEventListener('blur', () => { if (zoomInput.value !== zoomBefore) commitZoom(); else updateZoomUi(); });
zoomInput.addEventListener('focus', () => { zoomBefore = zoomInput.value; zoomInput.select(); });

container.addEventListener('wheel', (e) => {       // pinch / ctrl+wheel zoom
  if (!(e.ctrlKey || e.metaKey) || !pages.length) return;
  e.preventDefault();
  setZoom(curZoom() * Math.exp(-e.deltaY * (e.deltaMode ? .05 : .012)), { defer: true });
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('props').hidden) $('props').hidden = true;
    else if (!menu.hidden) { setMenu(false); btnMore.focus(); }
    else if (!dlMenu.hidden) { setDlMenu(false); $('btnDownload').focus(); }
    else if (tool && !(e.target.closest && e.target.closest('.annotationEditorLayer'))) setTool(null);   // Esc inside a text box only finishes the box
    return;
  }
  if (e.target instanceof HTMLInputElement) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); stepZoom(1); }
  else if (mod && e.key === '-') { e.preventDefault(); stepZoom(-1); }
  else if (mod && e.key === '0') { e.preventDefault(); zoomMode = 'fit-width'; applyLayout(); syncFitButton(); }
  else if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); $('btnPrint').click(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); $('btnDownload').click(); }
  else if (present || e.key === 'PageDown' || e.key === 'PageUp') {
    const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key), prev = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key);
    if ((next || prev) && present) { e.preventDefault(); goToPage(currentPage() + (next ? 1 : -1)); }
  }
});

let resizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (pages.length) applyLayout({ keepScale: zoomMode === 'custom' }); }, 120);
});

/* ---------- Ask DeepSeek: source info for the floating button ---------- */
function pageOf(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const pg = el && el.closest && el.closest('.pdf-page');
  return pg ? parseInt(pg.dataset.page, 10) : null;
}
globalThis.askDeepSeekSource = (range) => {
  const a = pageOf(range.startContainer), b = pageOf(range.endContainer);
  const first = a || b || 1, last = b || a || 1;
  return { title: sourceTitle, page: first === last ? String(first) : `${first}–${last}`, url: originalUrl.startsWith('file:') ? '' : originalUrl };
};

/* ---------- annotations: highlight / draw / text, kept in memory until you save ---------- */
// pdf.js's own editor layer does the editing and writes real PDF annotations on save.
// Nothing is written anywhere until you press Save / choose "With your changes".
class Bus {
  constructor() { this.m = new Map(); }
  on(n, f, o) {
    if (!this.m.has(n)) this.m.set(n, new Set());
    this.m.get(n).add(f);
    if (o && o.signal) o.signal.addEventListener('abort', () => this.off(n, f), { once: true });
  }
  _on(...a) { this.on(...a); }
  off(n, f) { const s = this.m.get(n); if (s) s.delete(f); }
  dispatch(n, d) { const s = this.m.get(n); if (s) for (const f of [...s]) { try { f(d); } catch (e) { console.error(e); } } }
}
const bus = new Bus();
let uiManager = null;

const EN = { // tiny stand-in for pdf.js's localisation; only strings that reach the screen
  'pdfjs-free-text2': { 'aria-label': 'Text box', 'default-content': 'Type here' },
  'pdfjs-editor-remove-button': { 'aria-label': 'Delete', title: 'Delete' },
  'pdfjs-editor-remove-ink-button': { 'aria-label': 'Delete drawing', title: 'Delete' },
  'pdfjs-editor-remove-freetext-button': { 'aria-label': 'Delete text', title: 'Delete' },
  'pdfjs-editor-remove-highlight-button': { 'aria-label': 'Delete highlight', title: 'Delete' },
  'pdfjs-editor-remove-stamp-button': { 'aria-label': 'Delete', title: 'Delete' }
};
const l10n = { get: async (id) => (EN[id] && EN[id].title) || '', translate: async () => {}, pause() {}, resume() {} };
function localize(root) {
  const nodes = root.nodeType === 1 ? [root, ...root.querySelectorAll('[data-l10n-id]')] : [];
  for (const n of nodes) {
    const id = n.getAttribute && n.getAttribute('data-l10n-id'); if (!id) continue;
    let s = EN[id];
    if (!s && /resizer/.test(id)) s = { 'aria-label': 'Resize' };
    else if (!s && /remove/.test(id)) s = { 'aria-label': 'Delete', title: 'Delete' };
    if (s) for (const k in s) n.setAttribute(k, s[k]);
  }
}
new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach(localize); }).observe(pagesEl, { childList: true, subtree: true });

const TOOLS = {
  highlight: { mode: ET.HIGHLIGHT, label: 'Pen size', min: 8, max: 24, size: 12, color: '#FFFF98', colors: ['#FFFF98', '#53FFBC', '#80EBFF', '#FFCBE6', '#FF4F5F'],
    colorTypes: [PT.HIGHLIGHT_DEFAULT_COLOR, PT.HIGHLIGHT_COLOR], sizeType: PT.HIGHLIGHT_THICKNESS },
  ink: { mode: ET.INK, label: 'Thickness', min: 1, max: 20, size: 3, color: '#3b82f6', colors: ['#1d1d28', '#e5484d', '#3b82f6', '#30a46c', '#f5a524', '#8e4ec6'],
    colorTypes: [PT.INK_COLOR], sizeType: PT.INK_THICKNESS },
  text: { mode: ET.FREETEXT, label: 'Size', min: 8, max: 72, size: 14, color: '#1d1d28', colors: ['#1d1d28', '#e5484d', '#3b82f6', '#30a46c', '#f5a524', '#8e4ec6'],
    colorTypes: [PT.FREETEXT_COLOR], sizeType: PT.FREETEXT_SIZE }
};
const savedTools = pref.get('annotTools', {});
for (const k of Object.keys(TOOLS)) {
  const s = savedTools[k]; if (!s) continue;
  if (typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color)) TOOLS[k].color = s.color;
  if (Number.isFinite(s.size)) TOOLS[k].size = clamp(s.size, TOOLS[k].min, TOOLS[k].max);
}
const saveToolPrefs = () => pref.set('annotTools', Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { color: t.color, size: t.size }])));

/* ---------- remember where you stopped (per document, in this browser only) ---------- */
const POS_KEY = 'pos', POS_MAX = 150;
let rememberOn = true, posReady = false, posT = 0;
function savePos() {
  if (!posReady || !rememberOn || !pdf || !pages.length || present) return;
  try {
    const page = currentPage(), p = pages[page - 1];
    const f = (container.scrollTop - getTops()[page - 1]) / Math.max(1, p.div.offsetHeight);
    const store = pref.get(POS_KEY, {});
    store[originalUrl] = { t: Date.now(), n: pdf.numPages, page, f: +f.toFixed(4), zm: zoomMode, z: +curZoom().toFixed(3), r: rotation, two: twoPage };
    const keys = Object.keys(store);
    if (keys.length > POS_MAX) for (const k of keys.sort((a, b) => store[a].t - store[b].t).slice(0, keys.length - POS_MAX)) delete store[k];
    pref.set(POS_KEY, store);
  } catch {}
}
function schedulePos() { if (!posReady) return; clearTimeout(posT); posT = setTimeout(savePos, 450); }
window.addEventListener('pagehide', savePos);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePos(); });
function readPos() {
  const s = pref.get(POS_KEY, {})[originalUrl];
  return s && s.n === pdf.numPages ? s : null;       // a different file at the same address is ignored
}

let tool = null, barOpen = false, dirty = false, undoable = false, redoable = false;

function initEditor() {
  uiManager = new AnnotationEditorUIManager(container, pagesEl, null, bus, pdf, null, 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F', false, false, false, null, null, true);
  const st = pdf.annotationStorage;
  st.onSetModified = () => markDirty(true);
  st.onResetModified = () => markDirty(false);
  // Every edit (and undo/redo) counts as a change since the last save, even right after a save.
  for (const fn of ['addCommands', 'undo', 'redo']) {
    const orig = uiManager[fn].bind(uiManager);
    uiManager[fn] = (...a) => { const r = orig(...a); markDirty(st.size > 0); return r; };
  }
  bus.on('annotationeditorstateschanged', ({ details }) => {
    if ('hasSomethingToUndo' in details) undoable = !!details.hasSomethingToUndo;
    if ('hasSomethingToRedo' in details) redoable = !!details.hasSomethingToRedo;
    $('aUndo').disabled = !undoable; $('aRedo').disabled = !redoable;
  });
  bus.on('annotationeditorparamschanged', ({ details }) => {      // selecting an existing mark shows its colour / size
    const t = TOOLS[tool]; if (!t) return;
    for (const [type, value] of details) {
      if (t.colorTypes.includes(type) && typeof value === 'string') { t.color = value.toLowerCase(); paintSwatches(); }
      else if (type === t.sizeType && Number.isFinite(value)) { t.size = clamp(value, t.min, t.max); paintSize(); }
    }
  });
  syncEditorView();
}

function syncEditorView() {
  if (!uiManager) return;
  const vp = uiManager.viewParameters;
  if (vp.realScale !== scale || vp.rotation !== rotation) { uiManager.commitOrRemove(); vp.realScale = scale; vp.rotation = rotation; }
}

function markDirty(v) {
  dirty = !!v && !!pdf && pdf.annotationStorage.size > 0;
  document.body.classList.toggle('dirty', dirty);
}
const hasEdits = () => !!pdf && pdf.annotationStorage.size > 0;

function mountEditor(p, viewport, textDiv, annDiv) {
  if (!uiManager) return;
  destroyEditor(p);
  try {
    const div = document.createElement('div'); div.className = 'annotationEditorLayer'; div.hidden = true; div.dir = 'ltr';
    p.div.appendChild(div);
    const draw = new DrawLayer({ pageIndex: p.num - 1 });
    draw.setParent(p.div.querySelector('.canvasWrapper'));
    const vp = viewport.clone({ dontFlip: true });
    const annotationLayer = { div: annDiv, getEditableAnnotations: () => [], getEditableAnnotation: () => null };
    const layer = new AnnotationEditorLayer({ uiManager, div, structTreeLayer: null, accessibilityManager: null, pageIndex: p.num - 1, l10n, viewport: vp, annotationLayer, textLayer: { div: textDiv }, drawLayer: draw });
    const addNew = layer.addNewEditor.bind(layer);          // keyboard shortcut path: no new boxes while selecting
    layer.addNewEditor = (...a) => (tool === 'select' ? undefined : addNew(...a));
    layer.render({ viewport: vp });
    div.hidden = layer.isInvisible;
    p.editor = { layer, draw, div };
  } catch (e) { console.error('annotation layer failed', p.num, e); }
}
function destroyEditor(p) {
  const ed = p.editor; if (!ed) return;
  p.editor = null;
  try { ed.layer.destroy(); } catch (e) { console.debug(e); }
  try { ed.draw.destroy(); } catch (e) { console.debug(e); }
  ed.div.remove();
}

/* --- tool bar --- */
function paintSwatches() {
  const t = TOOLS[tool], box = $('swatches'); if (!t) return;
  const cur = (t.color || '').toLowerCase();
  if (box.dataset.tool !== tool) {
    box.dataset.tool = tool; box.replaceChildren();
    for (const c of t.colors) {
      const b = document.createElement('button');
      b.className = 'sw'; b.dataset.color = c; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', 'Colour ' + c); b.title = c.toUpperCase();
      b.style.setProperty('--c', c);
      box.appendChild(b);
    }
  }
  for (const b of box.children) b.setAttribute('aria-checked', String(b.dataset.color.toLowerCase() === cur));
}
function paintSize() {
  const t = TOOLS[tool]; if (!t) return;
  const r = $('sizeRange');
  r.min = t.min; r.max = t.max; r.value = t.size; $('sizeOut').textContent = String(t.size); $('sizeLabel').textContent = t.label;
}
function paintTools() {
  document.querySelectorAll('.tool').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tool === tool)));
  const on = !!tool && tool !== 'select';
  $('swatches').hidden = !on; $('sizeBox').hidden = !on; $('sepColors').hidden = !on;
  if (on) { paintSwatches(); paintSize(); }
  document.body.toggleAttribute('data-annot', !!tool); if (tool) document.body.dataset.annot = tool;
}

async function setTool(next) {
  if (!uiManager) return;
  tool = next; paintTools();
  if (next !== 'select') uiManager.unselectAll();       // marks can only be grabbed with the Select tool
  try {
    // Select reuses an editing mode so existing marks stay interactive; creating new marks is blocked below.
    await uiManager.updateMode(next === 'select' ? ET.FREETEXT : next ? TOOLS[next].mode : ET.NONE);
    if (next && next !== 'select' && tool === next) {
      const t = TOOLS[next];
      for (const type of t.colorTypes) uiManager.updateParams(type, t.color);
      uiManager.updateParams(t.sizeType, t.size);
      pref.set('annotTool', next);
    }
  } catch (e) { console.error('annotation mode failed', e); }
}
function setBar(open) {
  if (open && !uiManager) return;
  barOpen = open;
  $('annotWrap').hidden = !open;
  $('btnAnnotate').setAttribute('aria-pressed', String(open));
  const last = pref.get('annotTool', 'highlight');
  if (open) setTool(TOOLS[last] ? last : 'highlight'); else setTool(null);
}

// In Select mode an empty click must not start a new mark; it just deselects.
pagesEl.addEventListener('pointerdown', (e) => {
  if (tool === 'select' && uiManager && e.target.classList && e.target.classList.contains('annotationEditorLayer')) { uiManager.unselectAll(); e.stopImmediatePropagation(); }
}, true);

$('btnAnnotate').addEventListener('click', () => setBar(!barOpen));
$('aDone').addEventListener('click', () => { setBar(false); $('btnAnnotate').focus(); });
$('tools').addEventListener('click', (e) => { const b = e.target.closest('.tool'); if (b) setTool(tool === b.dataset.tool ? null : b.dataset.tool); });
$('tools').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const bs = [...document.querySelectorAll('.tool')], i = bs.indexOf(document.activeElement); if (i < 0) return;
  e.preventDefault(); const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; n.focus(); setTool(n.dataset.tool);
});
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('.sw'); const t = TOOLS[tool]; if (!b || !t) return;
  t.color = b.dataset.color; saveToolPrefs(); paintSwatches();
  for (const type of t.colorTypes) uiManager.updateParams(type, t.color);
});
$('sizeRange').addEventListener('input', (e) => {
  const t = TOOLS[tool]; if (!t) return;
  t.size = +e.target.value; $('sizeOut').textContent = String(t.size); saveToolPrefs();
  uiManager.updateParams(t.sizeType, t.size);
});
$('aUndo').addEventListener('click', () => uiManager && uiManager.undo());
$('aRedo').addEventListener('click', () => uiManager && uiManager.redo());
$('aSave').addEventListener('click', () => downloadEdited());

/* --- saving --- */
function saveBlob(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const baseName = () => fileName.replace(/\.pdf$/i, '') || 'document';
async function downloadOriginal() {
  if (!pdf) return;
  saveBlob(await pdf.getData(), baseName() + '.pdf');
}
let saving = false;
async function downloadEdited() {
  if (!pdf || saving) return;
  if (!hasEdits()) return downloadOriginal();
  saving = true; $('aSave').setAttribute('aria-busy', 'true');
  try {
    uiManager.commitOrRemove();                     // finish any text box that is still being typed
    const bytes = await pdf.saveDocument();
    saveBlob(bytes, baseName() + '-annotated.pdf');
    pdf.annotationStorage.resetModified(); markDirty(false);
    toast('Saved with your changes');
  } catch (e) { console.error('save failed', e); toast('Could not save your changes'); }
  saving = false; $('aSave').removeAttribute('aria-busy');
}
const dlMenu = $('dlMenu');
function setDlMenu(open) {
  if (open) { const r = $('btnDownload').getBoundingClientRect(); dlMenu.style.right = Math.max(8, innerWidth - r.right) + 'px'; dlMenu.style.top = (r.bottom + 10) + 'px'; }
  dlMenu.hidden = !open; $('btnDownload').setAttribute('aria-expanded', String(open));
  if (open) $('dlEdited').focus({ preventScroll: true });
}
$('btnDownload').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!pdf) return;
  if (hasEdits()) setDlMenu(dlMenu.hidden); else downloadOriginal();
});
$('dlEdited').addEventListener('click', () => { setDlMenu(false); downloadEdited(); });
$('dlOriginal').addEventListener('click', () => { setDlMenu(false); downloadOriginal(); });
document.addEventListener('click', (e) => { if (!dlMenu.hidden && !dlMenu.contains(e.target)) setDlMenu(false); });
dlMenu.addEventListener('keydown', (e) => {
  const items = [...dlMenu.querySelectorAll('.item')]; const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});

// Same warning Chrome's viewer gives when closing a tab with unsaved marks.
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- init ---------- */
setMode(pref.get('mode', 'normal'));
theme = THEMES.includes(pref.get('theme', 'system')) ? pref.get('theme', 'system') : 'system'; applyTheme();
hue = pref.get('hue', 'violet'); applyHue();
setAnnots(pref.get('annots', true));
sidebarOpen = pref.get('sidebar', window.innerWidth > 900);
document.body.classList.toggle('sb-open', sidebarOpen);
$('btnSidebar').setAttribute('aria-pressed', String(sidebarOpen));
syncFitButton();
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('preload')));
load();
