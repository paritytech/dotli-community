// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { unmountIslands } from './mount/islands.js';
import { topbarStore } from './state/topbar.js';
import {
  registerTopbarElement,
  revealTopbar,
  scheduleTopbarHide,
  topbarTransition,
  TOPBAR_REVEAL_SHORTCUT,
} from './topbar-autohide.js';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Drive the host page's top bar (`#topbar`, rendered at build time by
 * apps/host/src/components/Topbar.astro) from the topbar store. The bar
 * slides out of view while the auto-hide (topbar-autohide.ts) has hidden
 * it, with no transition under reduced motion, carries the reveal shortcut
 * while the auto-hide is on, and reveals on a hover. Its offline banner
 * (`#offline-banner`) shows while the browser reports being offline and the
 * bar is visible, so it rides the auto-hide. On the landing page, which has
 * its own account and theme buttons, the bar hides (`data-landing`, see
 * styles/base.css) and its action group's island goes. Returns the unbind.
 */
export function bindTopbar(bar: HTMLElement): () => void {
  const banner = bar.querySelector<HTMLElement>('#offline-banner');
  const listeners = new AbortController();
  const { signal } = listeners;
  const unregister = registerTopbarElement(bar);
  bar.addEventListener('mouseenter', revealTopbar, { signal });
  bar.addEventListener('mouseleave', scheduleTopbarHide, { signal });

  let landed = false;
  const render = (): void => {
    const { visible, autoHide, landing } = topbarStore.get();
    bar.style.transform = visible ? 'translateY(0)' : 'translateY(-100%)';
    bar.style.transition = topbarTransition();
    if (autoHide) {
      bar.setAttribute('aria-keyshortcuts', TOPBAR_REVEAL_SHORTCUT);
    } else {
      bar.removeAttribute('aria-keyshortcuts');
    }
    bar.toggleAttribute('data-landing', landing);
    if (landing && !landed) {
      landed = true;
      unmountIslands(document.getElementById('topbar-actions'));
    }
    if (banner !== null) {
      banner.style.display = !navigator.onLine && visible ? 'block' : 'none';
    }
  };
  window.addEventListener('online', render, { signal });
  window.addEventListener('offline', render, { signal });
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(REDUCED_MOTION).addEventListener('change', render, { signal });
  }
  render();
  const unsubscribe = topbarStore.subscribe(render);
  return () => {
    listeners.abort();
    unsubscribe();
    unregister();
  };
}
