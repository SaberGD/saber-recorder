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

// حجم الواجهة: كل مدرب بيكبّرها أو يصغّرها على مزاجه (A− / A+)، وبيتحفظ على جهازه
const ZOOM_KEY = 'saber-recorder-ui-zoom';
const ZOOMS = [0.85, 1, 1.15, 1.3, 1.5];
function readZoom() {
  try { const z = Number(localStorage.getItem(ZOOM_KEY)); return ZOOMS.includes(z) ? z : 1; }
  catch { return 1; }
}
function applyZoom(zoom) {
  const root = document.documentElement;
  root.style.zoom = String(zoom);
  root.style.setProperty('--ui-zoom', String(zoom));
  const i = ZOOMS.indexOf(zoom);
  document.querySelectorAll('[data-zoom]').forEach(button => {
    button.disabled = button.dataset.zoom === 'out' ? i <= 0 : i >= ZOOMS.length - 1;
  });
}
applyZoom(readZoom());
document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
  const i = ZOOMS.indexOf(readZoom());
  const zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + (button.dataset.zoom === 'in' ? 1 : -1)))];
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* Keep the view usable if storage is unavailable. */ }
  applyZoom(zoom);
}));
window.addEventListener('storage', event => { if (event.key === ZOOM_KEY) applyZoom(readZoom()); });
