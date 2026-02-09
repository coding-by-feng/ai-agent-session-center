const views = ['live', 'history', 'timeline', 'analytics'];
const callbacks = {};

export function init() {
  document.getElementById('main-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn) return;
    const view = btn.dataset.view;
    switchTo(view);
  });
}

export function onViewChange(viewName, callback) {
  callbacks[viewName] = callback;
}

export function switchTo(viewName) {
  // Toggle active class on nav buttons
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
  // Toggle active class on view panels
  views.forEach(v => {
    const panel = document.getElementById(`view-${v}`);
    if (panel) panel.classList.toggle('active', v === viewName);
    if (panel) panel.classList.toggle('hidden', v !== viewName);
  });
  // Call view callback
  if (callbacks[viewName]) callbacks[viewName]();
}

export function getCurrentView() {
  return document.querySelector('.nav-btn.active')?.dataset.view || 'live';
}
