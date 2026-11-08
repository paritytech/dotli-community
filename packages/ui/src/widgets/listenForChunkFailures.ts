// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Vite's preload helper reports every dynamic import that failed, then rethrows to the caller, which reports the
// failure under its own step. Here it is only the reload offer and a breadcrumb with one count in front of that report.

import { createReporter, defineCount } from '@dotli/metrics';

const report = createReporter({ flow: 'boot' });

/**
 * A chunk Vite's preload helper failed to load, mostly a deploy that replaced it. Tagged `outcome` and `reason` (the
 * error's name). The caller of the import counts the failure with a breadcrumb, so this reads as the rate behind those.
 */
const chunkPreloadMetric = defineCount<'error'>('chunk.preload');

type Params = {
  /** The page's window, where Vite reports a failed preload. */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** The page's one reload offer. */
  offerReload: () => void;
};

/**
 * Offers a reload when a chunk fails to load, until the returned stop. Never throws unless `offerReload` does.
 *
 * @example
 * const offerReload = createReloadOffer({ notify: showNotification, reload: reloadPage });
 * const stop = listenForChunkFailures({ target: window, offerReload });
 */
export function listenForChunkFailures({ target, offerReload }: Params): () => void {
  function handlePreloadError(event: Event): void {
    const error = readPayload(event) ?? new Error('vite:preloadError');
    // The caller that imported the chunk counts the failure with its own breadcrumb, so this adds only the rate.
    report.expected(error, { step: 'chunk_preload', metric: chunkPreloadMetric });
    offerReload();
  }

  target.addEventListener('vite:preloadError', handlePreloadError);
  return () => {
    target.removeEventListener('vite:preloadError', handlePreloadError);
  };
}

/** The error Vite's preload event carries, if any. */
function readPayload(event: Event): unknown {
  return 'payload' in event ? event.payload : undefined;
}
