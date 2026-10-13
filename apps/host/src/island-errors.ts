// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An island whose code failed to load or hydrate. Astro catches it and dispatches `astro:hydration-error` on the
// island, so it would reach the console alone. A failure inside a hydrated island is its own boundary's.

import { captureException } from '@dotli/metrics';
import { offerReload, type ShowNotification } from '@dotli/ui-widgets';

export interface IslandErrorDeps {
  /** Where Astro dispatches `astro:hydration-error`. */
  target?: EventTarget;
  notify: ShowNotification;
  reload: () => void;
}

interface HydrationErrorDetail {
  error: unknown;
  componentUrl: string | null;
}

/** The `astro-island` element a failure is dispatched on, as much of it as the report reads. */
interface Island {
  getAttribute(name: string): string | null;
}

function islandOf(ev: Event): Island | null {
  const target = ev.target as Partial<Island> | null;
  return typeof target?.getAttribute === 'function' ? (target as Island) : null;
}

/**
 * Reports each island that fails to load or hydrate and offers a reload, from now until the returned stop. An island
 * that never ran cannot stand in for itself, and a reload is the one way out that fits every island.
 */
export function reportIslandErrors({ target = document, notify, reload }: IslandErrorDeps): () => void {
  const onError = (ev: Event): void => {
    // Replaces Astro's console log.
    ev.preventDefault();
    const component = islandOf(ev)?.getAttribute('component-export') ?? 'unknown';
    captureException((ev as CustomEvent<HydrationErrorDetail>).detail.error, {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: `island:${component}`, kind: 'island_hydration_error' },
    });
    offerReload(notify, reload);
  };
  target.addEventListener('astro:hydration-error', onError);
  return () => {
    target.removeEventListener('astro:hydration-error', onError);
  };
}
