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
const inDs = document.getElementById('indeepseek');
chrome.storage.local.get({ askInDeepSeek: true }).then(v => { inDs.checked = v.askInDeepSeek !== false; });
inDs.addEventListener('change', async () => {
  await chrome.storage.local.set({ askInDeepSeek: inDs.checked });
  saved.classList.add('on'); setTimeout(() => saved.classList.remove('on'), 1200);
});
document.getElementById('forget').addEventListener('click', () => {
  try { localStorage.removeItem('askds.pos'); } catch {}
  document.getElementById('forgot').textContent = 'Done. All saved positions are cleared.';
});
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('preload')));
