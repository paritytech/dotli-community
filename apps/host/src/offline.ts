// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Surfaces a banner when the browser reports offline status.
//
// As a PWA the host shell boots entirely from the service worker cache, so
// losing connectivity is otherwise invisible to the user. The banner is
// parented to the topbar so it rides the auto-hide transform. It also
// listens for the topbar:visibility event from main.ts so the banner does
// not dangle into the viewport once the topbar has slid off screen.

let banner: HTMLElement | null = null;
let topbarVisible = true;

function ensureBanner(): HTMLElement {
  if (banner) {
    return banner;
  }
  const topbar = document.getElementById("topbar");
  const el = document.createElement("div");
  el.id = "offline-banner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = "You are offline";
  el.style.cssText = [
    topbar ? "position: absolute" : "position: fixed",
    topbar ? "top: 100%" : "top: 56px",
    "left: 0",
    "right: 0",
    "z-index: 999",
    "background: #b45309",
    "color: #fff",
    "font-size: 0.75rem",
    "font-weight: 500",
    "text-align: center",
    "padding: 4px 12px",
    "letter-spacing: 0.02em",
    "display: none",
  ].join("; ");
  (topbar ?? document.body).appendChild(el);
  banner = el;
  return el;
}

function update(): void {
  const el = ensureBanner();
  el.style.display = !navigator.onLine && topbarVisible ? "block" : "none";
}

window.addEventListener("online", update);
window.addEventListener("offline", update);
window.addEventListener("topbar:visibility", (event) => {
  topbarVisible = (event as CustomEvent<boolean>).detail;
  update();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", update, { once: true });
} else {
  update();
}
