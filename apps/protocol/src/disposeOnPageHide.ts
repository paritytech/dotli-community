// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** The page whose `pagehide` disposes the unit. */
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Releases what the unit holds. */
  dispose: () => void;
};

/**
 * Calls `dispose` once the page is hidden for good, and returns the stop that removes its listener, safe to call twice.
 * `pagehide` and not `beforeunload`, because a removed frame fires only the former. A page kept in the back-forward
 * cache may come back, so it keeps what it holds.
 */
export function disposeOnPageHide({ target, dispose }: Params): () => void {
  target.addEventListener('pagehide', onPageHide);
  return stop;

  function onPageHide(event: PageTransitionEvent): void {
    if (event.persisted) {
      return;
    }
    stop();
    dispose();
  }

  function stop(): void {
    target.removeEventListener('pagehide', onPageHide);
  }
}
