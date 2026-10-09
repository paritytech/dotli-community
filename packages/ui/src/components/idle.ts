// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const PRELOAD_TIMEOUT_MS = 2000;

/**
 * Preload a lazy component's chunk once the browser is idle, so its first render skips the network.
 * A failed preload is left to the first render, which loads it again. Returns the cancel function.
 */
export function preloadWhenIdle(component: { preload: () => Promise<unknown> }): () => void {
  const run = (): void => {
    component.preload().catch(() => undefined);
  };
  // Both or neither: happy-dom has only one of them, so it takes the timer.
  if (typeof window.requestIdleCallback === 'function' && typeof window.cancelIdleCallback === 'function') {
    // Bound now so the cancel pairs with the request that scheduled it.
    const cancel = window.cancelIdleCallback.bind(window);
    const handle = window.requestIdleCallback(run, { timeout: PRELOAD_TIMEOUT_MS });
    return () => {
      cancel(handle);
    };
  }
  const timer = setTimeout(run, PRELOAD_TIMEOUT_MS);
  return () => {
    clearTimeout(timer);
  };
}
