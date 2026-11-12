// Runs before first paint: apply the saved/system theme to <html> so the reader never flashes the wrong colours.
(function () {
  document.documentElement.classList.add('preload');   // no slide-in animations on first paint
  try {
    var t = JSON.parse(localStorage.getItem('askds.theme') || '"system"');
    var light = t === 'light' || (t === 'system' && !matchMedia('(prefers-color-scheme: dark)').matches);
    if (light) document.documentElement.classList.add('light');
  } catch (e) {}
})();
