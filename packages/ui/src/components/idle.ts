// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** How long an idle preload waits for the browser to go idle. */
const PRELOAD_TIMEOUT_MS = 2000;

/**
 * Preload a lazy component's chunk once the browser is idle (or after 2 s
 * on a browser without idle callbacks), so its first render does not wait
 * for the network. A failed preload is left to the first render, which
 * loads it again. Returns the function that cancels it.
 */
export function preloadWhenIdle(component: { preload: () => Promise<unknown> }): () => void {
  const run = (): void => {
    component.preload().catch(() => undefined);
  };
  // Both or neither: an environment with only one of them (happy-dom) takes
  // the timer.
  if (typeof window.requestIdleCallback === 'function' && typeof window.cancelIdleCallback === 'function') {
    // Kept from now: the cancel pairs with the request that scheduled it.
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
