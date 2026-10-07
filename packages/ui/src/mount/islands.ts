// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Island hydration failures. Solid-free because the host's startup path runs it.

import { captureException } from '@dotli/metrics';
import { disableAuthModal } from '../auth-controller.js';
import type { ReadableStore } from '../state/create-store.js';
import { loadingStore } from '../state/loading.js';
import { topbarStore } from '../state/topbar.js';
import { showBrokenPage } from '../ui.js';

declare global {
  interface Window {
    /** Failures the host page's inline script kept before reportIslandErrors listens, null once it does. */
    __dotliIslandErrors?: Event[] | null;
  }
}

interface HydrationErrorDetail {
  error: unknown;
  componentUrl: string | null;
}

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
 * Stands in for an island that failed to hydrate, whose build-time markup stays. AuthModal is disabled
 * so a login never holds the blocking-modal lease for a modal nobody can see.
 */
function onIslandError(ev: Event): void {
  // Replaces Astro's console log.
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

export function reportIslandErrors(): () => void {
  const early = window.__dotliIslandErrors ?? [];
  window.__dotliIslandErrors = null;
  document.addEventListener('astro:hydration-error', onIslandError);
  early.forEach(onIslandError);
  return () => {
    document.removeEventListener('astro:hydration-error', onIslandError);
  };
}
