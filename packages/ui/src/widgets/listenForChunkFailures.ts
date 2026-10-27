// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Vite's preload helper reports every dynamic import that failed, then rethrows to the caller, which reports the
// failure under its own step. Here it is only the reload offer and a breadcrumb with one count in front of that report.

import { reportExpected, spans as S } from '@dotli/metrics';

type Params = {
  /** The page's window, where Vite reports a failed preload. */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** The page's one reload offer. */
  offerReload: () => void;
};

/** Offers a reload when a chunk fails to load, until the returned stop. Never throws unless `offerReload` does. */
export function listenForChunkFailures({ target, offerReload }: Params): () => void {
  function handlePreloadError(event: Event): void {
    const error = readPayload(event) ?? new Error('vite:preloadError');
    // The caller that imported the chunk counts the failure with its own breadcrumb, so this adds only the rate.
    reportExpected(error, { flow: 'boot', step: 'chunk_preload', metric: S.CHUNK_PRELOAD });
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
