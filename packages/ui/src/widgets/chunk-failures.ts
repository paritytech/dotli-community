// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Vite's preload helper reports every dynamic import that failed, then rethrows to the caller, which reports the
// failure under its own step. Here it is only the reload offer and a breadcrumb with one count in front of that report.

import { reportExpected, spans as S } from '@dotli/metrics';
import type { ShowNotification } from './notification.js';

export type ChunkFailureDeps = {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** The page's one reload offer. */
  offerReload: () => void;
};

/**
 * The page's one reload offer, for any part of it that failed to load, most likely because a new version was
 * deployed. Asked again while it shows, it adds nothing. Once the visitor closes it, the next failure offers again.
 */
export function createReloadOffer(notify: ShowNotification, reload: () => void): () => void {
  let showing = false;
  return () => {
    if (showing) {
      return;
    }
    showing = true;
    // The user opts into a reload rather than getting a silent one.
    notify({
      label: 'Asset failed to load',
      text: 'A new version may have been deployed. Reload to get the latest.',
      tone: 'err',
      dismissMs: 0,
      action: { label: 'Reload', onClick: reload },
      onDismiss: () => {
        showing = false;
      },
    });
  };
}

/** Offers a reload when a chunk fails to load, until the returned stop. */
export function listenForChunkFailures({ target, offerReload }: ChunkFailureDeps): () => void {
  const onPreloadError = (event: Event): void => {
    const error = (event as Event & { payload?: unknown }).payload ?? new Error('vite:preloadError');
    // The caller that imported the chunk counts the failure with its own breadcrumb, so this adds only the rate.
    reportExpected(error, { flow: 'boot', step: 'chunk_preload', metric: S.CHUNK_PRELOAD });
    offerReload();
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError);
  };
}
