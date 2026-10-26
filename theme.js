import { ICONS } from './lib/icons.js';

const KEY = 'saber-recorder-ui-theme';
function readTheme() {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-toggle]').forEach(button => {
    const label = theme === 'dark' ? 'تفعيل المظهر الفاتح' : 'تفعيل المظهر الداكن';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
  });
}
applyTheme(readTheme());
document.querySelectorAll('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(KEY, theme); } catch { /* Keep the view usable if storage is unavailable. */ }
  applyTheme(theme);
}));
window.addEventListener('storage', event => { if (event.key === KEY) applyTheme(readTheme()); });
