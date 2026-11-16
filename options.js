const box = document.getElementById('intercept');
const saved = document.getElementById('saved');
chrome.storage.local.get({ interceptPdfs: true }).then(v => { box.checked = v.interceptPdfs; });
box.addEventListener('change', async () => {
  await chrome.storage.local.set({ interceptPdfs: box.checked });
  saved.classList.add('on');
  setTimeout(() => saved.classList.remove('on'), 1200);
});

const remember = document.getElementById('remember');
chrome.storage.local.get({ rememberPosition: true }).then(v => { remember.checked = v.rememberPosition !== false; });
remember.addEventListener('change', async () => {
  await chrome.storage.local.set({ rememberPosition: remember.checked });
  saved.classList.add('on'); setTimeout(() => saved.classList.remove('on'), 1200);
});
document.getElementById('forget').addEventListener('click', () => {
  try { localStorage.removeItem('askds.pos'); } catch {}
  document.getElementById('forgot').textContent = 'Done. All saved positions are cleared.';
});
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('preload')));

// If the theme or colour is changed in the reader while this page is open, follow it.
window.addEventListener('storage', (e) => {
  if (e.key !== 'askds.theme' && e.key !== 'askds.hue') return;
  const read = (k, d) => { try { const v = localStorage.getItem('askds.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const t = read('theme', 'system');
  document.documentElement.classList.toggle('light', t === 'light' || (t === 'system' && !matchMedia('(prefers-color-scheme: dark)').matches));
  const shift = { violet: 0, magenta: 50, rose: 90, amber: 150, emerald: -105, teal: -75, ocean: -40 };
  document.documentElement.style.setProperty('--hs', (shift[read('hue', 'violet')] || 0) + 'deg');
});
