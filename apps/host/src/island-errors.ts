// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An island whose code failed to load or hydrate. Astro catches it and dispatches `astro:hydration-error` on the
// island, so it would reach the console alone. A failure inside a hydrated island is its own boundary's. An island that
// never ran gets its stand-in here. One that fails before boot listens, such as an island that loads with the page,
// reaches the console alone.

import { captureException } from '@dotli/metrics';

export type IslandErrorDeps = {
  /** Where Astro dispatches `astro:hydration-error`. */
  target?: EventTarget;
  /** The page's one reload offer. */
  offerReload: () => void;
  /** What an island must still do when its code never ran, by its `component-export` name. */
  standIns?: Readonly<Record<string, () => void>>;
};

type HydrationErrorDetail = {
  error: unknown;
  componentUrl: string | null;
};

/** The `astro-island` element a failure is dispatched on, as much of it as the report reads. */
type Island = {
  getAttribute(name: string): string | null;
};

function islandOf(ev: Event): Island | null {
  const target = ev.target as Partial<Island> | null;
  return typeof target?.getAttribute === 'function' ? (target as Island) : null;
}

/**
 * Reports each island that fails to load or hydrate and offers a reload, from now until the returned stop. A reload is
 * the one way out that fits every island.
 */
export function reportIslandErrors({ target = document, offerReload, standIns = {} }: IslandErrorDeps): () => void {
  const onError = (ev: Event): void => {
    // Replaces Astro's console log.
    ev.preventDefault();
    const component = islandOf(ev)?.getAttribute('component-export') ?? 'unknown';
    captureException((ev as CustomEvent<HydrationErrorDetail>).detail.error, {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: `island:${component}`, kind: 'island_hydration_error' },
    });
    standIns[component]?.();
    offerReload();
  };
  target.addEventListener('astro:hydration-error', onError);
  return () => {
    target.removeEventListener('astro:hydration-error', onError);
  };
}

/** The page's stand-ins: a sign-in must never hold the lease for a modal nobody sees, nor a prompt wait forever. */
export function pageStandIns(deps: {
  disableAuthModal: () => void;
  refuseModals: () => void;
}): Record<string, () => void> {
  return { AuthModal: deps.disableAuthModal, Overlays: deps.refuseModals };
}
