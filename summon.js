// === Shared "summon" animation for card windows ===
// Every floating glass card (assistant, notes, info, stats, week strip, focus
// bar, hover card) loads this snippet. main.js tells it when the window is
// being shown/hidden so the renderer can re-trigger a clean entrance/exit
// animation instead of the window popping in/out instantly. Pure
// transform/opacity — compositor-safe, no layout thrash.
(function () {
  var api = window.electronAPI;
  if (!api || !api.onSummonAnimate) return;

  // The window's root glass card. Each window uses a different id, so try
  // them in order; anything without one falls back to the whole body.
  var root =
    document.querySelector('[data-summon]') ||
    document.querySelector(
      '#assistant-glass, #notes-glass, #info-glass, #week, #fbar, #hover-card, #row-hover-card, .wrap'
    ) ||
    document.body;

  // Inject the keyframes once per window (each window has its own document).
  var style = document.createElement('style');
  style.textContent =
    '@keyframes haloSummonIn { from { opacity: 0; transform: translateY(10px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }\n' +
    '.summon-in { animation: haloSummonIn 0.28s cubic-bezier(0.22, 0.61, 0.36, 1) both !important; }\n' +
    '@keyframes haloSummonOut { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(8px) scale(0.98); } }\n' +
    '.summon-out { animation: haloSummonOut 0.16s cubic-bezier(0.4, 0, 1, 1) both !important; }';
  document.head.appendChild(style);

  function animateIn() {
    if (!root) return;
    // Remove + re-add (with a reflow in between) so the animation replays on
    // every summon, not just the first page paint. Also clear a leftover
    // fade-out class (window re-shown mid-hide).
    root.classList.remove('summon-in');
    root.classList.remove('summon-out');
    void root.offsetWidth;
    root.classList.add('summon-in');
  }

  function animateOut() {
    if (!root) return;
    root.classList.remove('summon-in');
    root.classList.add('summon-out');
    // Tell main the fade finished so it can hide the window (fallback timer
    // in main covers a hung renderer).
    setTimeout(function () { if (api.summonLeaveDone) api.summonLeaveDone(); }, 170);
  }

  api.onSummonAnimate(animateIn);
  api.onSummonLeave(animateOut);
})();
