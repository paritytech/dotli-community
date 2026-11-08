// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An island whose code failed to load or hydrate. Astro catches it and dispatches `astro:hydration-error` on the
// island, so it would reach the console alone. A failure inside a hydrated island is its own boundary's. An island that
// never ran gets its stand-in here. One that fails before boot listens, such as an island that loads with the page,
// reaches the console alone.

import { createReporter } from '@dotli/metrics';
import { isRecord } from '@dotli/shared';

const report = createReporter({ flow: 'ui' });

type ReportIslandErrorsParams = {
  /** Where Astro dispatches `astro:hydration-error`. */
  target?: EventTarget;
  /** The page's one reload offer. */
  offerReload: () => void;
  /** What an island must still do when its code never ran, by its `component-export` name. */
  standIns?: Readonly<Record<string, () => void>>;
};

type GetPageStandInsParams = {
  /** Ends the sign-in modal's lease. */
  disableAuthModal: () => void;
  /** Refuses every modal that waits on the overlays. */
  refuseModals: () => void;
};

/** The `astro-island` element a failure is dispatched on, as much of it as the report reads. */
type Island = {
  getAttribute(name: string): string | null;
};

/**
 * Reports each island that fails to load or hydrate and offers a reload, from now until the returned stop. A reload is
 * the one way out that fits every island. Never throws.
 */
export function reportIslandErrors({
  target = document,
  offerReload,
  standIns = {},
}: ReportIslandErrorsParams): () => void {
  function onError(event: Event): void {
    // Replaces Astro's console log.
    event.preventDefault();
    const island = isIsland(event.target) ? event.target : null;
    const component = island?.getAttribute('component-export') ?? 'unknown';
    report.capture(readHydrationError(event), {
      step: 'island_hydration',
      tags: { root: `island:${component}`, kind: 'island_hydration_error' },
    });
    standIns[component]?.();
    offerReload();
  }
  function dispose(): void {
    target.removeEventListener('astro:hydration-error', onError);
  }
  target.addEventListener('astro:hydration-error', onError);
  return dispose;
}

/**
 * Returns the page's stand-ins: a sign-in must never hold the lease for a modal nobody sees, nor a prompt wait forever.
 * Never throws.
 */
export function getPageStandIns({ disableAuthModal, refuseModals }: GetPageStandInsParams): Record<string, () => void> {
  return { AuthModal: disableAuthModal, Overlays: refuseModals };
}

function isIsland(target: EventTarget | null): target is EventTarget & Island {
  return target !== null && 'getAttribute' in target && typeof target.getAttribute === 'function';
}

/** Returns the failure Astro put on `event`, or undefined when it carries none. */
function readHydrationError(event: Event): unknown {
  if (!(event instanceof CustomEvent) || !isRecord(event.detail)) {
    return undefined;
  }
  return event.detail['error'];
}
