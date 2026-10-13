// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An island can hydrate before the page's entry runs, so the page's head script queues its failures until
// reportIslandErrors listens. The head script bundles this module, so it imports nothing.

declare global {
  interface Window {
    /** Failures the head script kept before reportIslandErrors listens, null once it does. */
    __dotliIslandErrors?: Event[] | null;
  }
}

/** The page's window, as much of it as the queue uses. */
export interface IslandErrorQueuePage {
  __dotliIslandErrors?: Event[] | null;
}

/** Keeps each hydration failure `target` dispatches on `page`, until takeQueuedIslandErrors. */
export function queueIslandErrors(page: IslandErrorQueuePage, target: Pick<EventTarget, 'addEventListener'>): void {
  page.__dotliIslandErrors = [];
  target.addEventListener('astro:hydration-error', event => {
    page.__dotliIslandErrors?.push(event);
  });
}

/** The failures queued so far. The queue stops keeping more, since the caller now listens itself. */
export function takeQueuedIslandErrors(page: IslandErrorQueuePage): readonly Event[] {
  const early = page.__dotliIslandErrors ?? [];
  page.__dotliIslandErrors = null;
  return early;
}
