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

    /**
     * Whether the app can be torn down right now.
     *
     * The game shell publishes this. It is false while a run is in progress and
     * while a finished run still has an unsaved score.
     */
    const busy = (): boolean => {
      const probe = (window as { __mathfallBusy?: () => boolean }).__mathfallBusy;
      // Assume busy if the shell has not booted yet: reloading mid-boot is
      // never useful, and the check runs again the moment it becomes idle.
      if (typeof probe !== 'function') return true;
      try { return probe(); } catch { return false; }
    };

    void navigator.serviceWorker.register(`${base}sw.js`, { scope: base })
      .then((reg) => {
        // Check for a new build whenever the app is brought back to the
        // foreground. Installed to a home screen, a PWA can otherwise run the
        // same cached bundle for days without ever hitting the network for a
        // fresh index.html.
        //
        // Never during a run. Installing a new worker swaps the cached assets
        // underneath a page that is still executing the old build.
        const check = () => {
          if (document.hidden || busy()) return;
          void reg.update().catch(() => undefined);
        };
        document.addEventListener('visibilitychange', check);
        window.addEventListener('mathfall:idle', check);
        window.setInterval(check, 15 * 60 * 1000);
      })
      .catch(() => undefined);

    // The new worker calls skipWaiting and claims clients immediately, but the
    // page keeps running whichever JS it already parsed. Reloading once on
    // handover is what actually delivers the update — without it, a fix can be
    // live and still invisible on the device, which is indistinguishable from
    // a fix that never shipped.
    //
    // But it must never happen mid-run. Reported by a player as the game
    // "leaving by itself": a build landing while they were playing reloaded the
    // page and took the run with it, including one that had been going for
    // hours. An update is worth nothing next to a run in progress, so it waits
    // for the menu.
    let reloading = false;
    let updatePending = false;

    const applyUpdate = () => {
      if (reloading || !updatePending || busy()) return;
      reloading = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      updatePending = true;
      applyUpdate();
    });

    // The shell fires this whenever it returns to a state where losing the
    // page costs nothing.
    window.addEventListener('mathfall:idle', applyUpdate);
  });
}
