// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Island hydration failures. Imports no Solid because boot runs it before any island. Boot passes what a failed
// island is stood in for with, so this reads none of the shell's state.

import { captureException } from '@dotli/metrics';
import type { ReadableStore } from '@dotli/shared';
import { takeQueuedIslandErrors } from './island-error-queue.js';

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

/** The `astro-island` element a failure is dispatched on, as much of it as the stand-ins use. */
interface Island {
  getAttribute(name: string): string | null;
  replaceChildren(): void;
}

/** The loading screen's store, and which of its states mean the screen is gone. */
export interface IslandLoading<L> {
  store: ReadableStore<L>;
  gone: (state: L) => boolean;
}

/** What a failed island is stood in for with. */
export interface IslandStandIns {
  disableAuthModal(): void;
  showBrokenPage(): void;
}

export interface IslandErrorOptions<L> {
  /** Where Astro dispatches `astro:hydration-error`. */
  target?: EventTarget;
  /** Failures from before this listens. The default takes the page's head script queue. */
  early?: readonly Event[];
  /** A LoadingScreen island that failed is cleared once the screen is gone. */
  loading: IslandLoading<L>;
  standIns: IslandStandIns;
}

function islandOf(ev: Event): Island | null {
  const target = ev.target as Partial<Island> | null;
  return typeof target?.getAttribute === 'function' ? (target as Island) : null;
}

/**
 * Stands in for an island that failed to hydrate, whose build-time markup stays. AuthModal is disabled
 * so a login never holds the blocking-modal lease for a modal nobody can see.
 */
function onIslandError<L>(ev: Event, loading: IslandLoading<L>, standIns: IslandStandIns): void {
  // Replaces Astro's console log.
  ev.preventDefault();
  const island = islandOf(ev);
  const component = island?.getAttribute('component-export') ?? 'unknown';
  const { error } = (ev as CustomEvent<HydrationErrorDetail>).detail;
  captureException(error, {
    flow: 'ui',
    step: 'island_hydration',
    tags: { root: `island:${component}`, kind: 'island_hydration_error' },
  });
  switch (component) {
    case 'AuthModal':
      standIns.disableAuthModal();
      break;
    case 'LoadingScreen':
      once(loading.store, loading.gone, () => {
        island?.replaceChildren();
      });
      break;
    case 'LandingAuth':
    case 'LandingNav':
    case 'LandingRecents':
      // The page's only controls, so it fails whole.
      standIns.showBrokenPage();
      break;
  }
}

export function reportIslandErrors<L>(options: IslandErrorOptions<L>): () => void {
  const target = options.target ?? document;
  const early = options.early ?? takeQueuedIslandErrors(window);
  const { loading, standIns } = options;
  const onError = (ev: Event): void => {
    onIslandError(ev, loading, standIns);
  };
  target.addEventListener('astro:hydration-error', onError);
  early.forEach(onError);
  return () => {
    target.removeEventListener('astro:hydration-error', onError);
  };
}
