/*! coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
/*global self*/
if (typeof window === 'undefined') {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", function (e) {
    if (
      e.request.cache === "only-if-cached" &&
      e.request.mode !== "same-origin"
    ) {
      return;
    }

    e.respondWith(
      fetch(e.request)
        .then(function (res) {
          if (res.status === 0) {
            return res;
          }

          const newHeaders = new Headers(res.headers);
          newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: newHeaders,
          });
        })
        .catch(function (e) {
          console.error(e);
        })
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coepDegrading = reloadedBySelf === "coepdegrade";

    // You can customize the behavior of this script through a global `cpiConfiguration` variable.
    const n = {
      quiet: false,
      ...window.coi,
    };

    if (window.crossOriginIsolated !== false || !window.isSecureContext) {
      if (!n.quiet) console.log("COOP/COEP Service Worker not necessary.");
      if (window.crossOriginIsolated) {
        return;
      }
    }

    if (!window.isSecureContext) {
      !n.quiet &&
        console.log(
          "COOP/COEP Service Worker not registered, a]secure context is required."
        );
      return;
    }

    // In some environments (e.g. Firefox private mode) service workers are not available.
    if (!("serviceWorker" in navigator)) {
      !n.quiet &&
        console.error("COOP/COEP Service Worker not registered, Service Worker API not available.");
      return;
    }

    navigator.serviceWorker
      .register(new URL("coi-serviceworker.js", window.location.href).href)
      .then(
        (registration) => {
          !n.quiet &&
            console.log(
              "COOP/COEP Service Worker registered",
              registration.scope
            );

          registration.addEventListener("updatefound", () => {
            !n.quiet &&
              console.log(
                "Reloading page to make use of updated COOP/COEP Service Worker."
              );
            window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
            window.location.reload();
          });

          // If the registration is active, but it's not controlling the page
          if (registration.active && !navigator.serviceWorker.controller) {
            !n.quiet &&
              console.log(
                "Reloading page to make use of COOP/COEP Service Worker."
              );
            window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
            window.location.reload();
          }
        },
        (err) => {
          !n.quiet &&
            console.error(
              "COOP/COEP Service Worker failed to register:",
              err
            );
        }
      );
  })();
}
