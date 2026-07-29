import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById("root")!).render(<App />);

// Offline support. Registered after load so it never competes with the first
// paint, and only in production — a service worker sitting in front of the dev
// server hands back stale modules and is a reliable way to lose an afternoon.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL || '/';
    void navigator.serviceWorker.register(`${base}sw.js`, { scope: base })
      .then((reg) => {
        // Check for a new build whenever the app is brought back to the
        // foreground. Installed to a home screen, a PWA can otherwise run the
        // same cached bundle for days without ever hitting the network for a
        // fresh index.html.
        const check = () => { if (!document.hidden) void reg.update().catch(() => undefined); };
        document.addEventListener('visibilitychange', check);
        window.setInterval(check, 15 * 60 * 1000);
      })
      .catch(() => undefined);

    // The new worker calls skipWaiting and claims clients immediately, but the
    // page keeps running whichever JS it already parsed. Reloading once on
    // handover is what actually delivers the update — without it, a fix can be
    // live and still invisible on the device, which is indistinguishable from
    // a fix that never shipped.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}
