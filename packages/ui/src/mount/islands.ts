// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's side of the shell's islands (the Astro page, see
// src/islands/): their failures. Solid-free: the host's startup path runs
// it.

import { captureException } from '@dotli/metrics';
import { disableAuthModal } from '../auth-controller.js';
import type { ReadableStore } from '../state/create-store.js';
import { loadingStore } from '../state/loading.js';
import { topbarStore } from '../state/topbar.js';
import { showBrokenPage } from '../ui.js';

declare global {
  interface Window {
    /**
     * The islands' failures from before reportIslandErrors listens, kept by
     * the host page's inline script; null once it listens.
     */
    __dotliIslandErrors?: Event[] | null;
  }
}

interface HydrationErrorDetail {
  error: unknown;
  componentUrl: string | null;
}

/** Run `act` once `when` holds for the store's value, now or later. */
function once<T>(store: ReadableStore<T>, when: (value: T) => boolean, act: () => void): void {
  if (when(store.get())) {
    act();
    return;
  }
  const unsubscribe = store.subscribe(() => {
    if (when(store.get())) {
      unsubscribe();
      act();
    }
  });
}

/**
 * Report an island that failed to load or hydrate (Astro's
 * `astro:hydration-error`), and stand in for what it would have done. Its
 * build-time markup stays, as rendered:
 * - AuthModal: the auth modal is disabled (disableAuthModal), so a login
 *   never holds the blocking-modal lease for a modal nobody can see.
 * - LoadingScreen: its markup goes once the loading screen does.
 * - LandingPage: the landing page shows the reload error page instead.
 */
function onIslandError(ev: Event): void {
  // In place of Astro's console log, for a failure while this listens.
  ev.preventDefault();
  const island = ev.target instanceof Element ? ev.target : null;
  const component = island?.getAttribute('component-export') ?? 'unknown';
  const { error } = (ev as CustomEvent<HydrationErrorDetail>).detail;
  captureException(error, {
    flow: 'ui',
    step: 'island_hydration',
    tags: { root: `island:${component}`, kind: 'island_hydration_error' },
  });
  switch (component) {
    case 'AuthModal':
      disableAuthModal();
      break;
    case 'LoadingScreen':
      once(
        loadingStore,
        state => state.phase === 'gone',
        () => {
          island?.replaceChildren();
        },
      );
      break;
    case 'LandingPage':
      once(topbarStore, state => state.landing, showBrokenPage);
      break;
  }
}

/**
 * Handle the islands' failures: the ones the page kept before this ran
 * (`window.__dotliIslandErrors`), then each as it happens. Returns the
 * function that stops listening.
 */
export function reportIslandErrors(): () => void {
  const early = window.__dotliIslandErrors ?? [];
  window.__dotliIslandErrors = null;
  document.addEventListener('astro:hydration-error', onIslandError);
  early.forEach(onIslandError);
  return () => {
    document.removeEventListener('astro:hydration-error', onIslandError);
  };
}
