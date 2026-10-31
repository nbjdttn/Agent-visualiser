import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support once installed on the Home Screen (production builds only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

// No pinch-zoom on iPhone (Safari ignores user-scalable=no on its own).
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// No long-press menus on touch screens (the CSS stops iPhone's; this stops the
// ones other phones open), except where you type or copy the setup code.
if (window.matchMedia('(pointer: coarse)').matches) {
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"], .select-all'))) e.preventDefault();
  });
}
