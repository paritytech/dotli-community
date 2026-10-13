// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Vite's preload helper reports every dynamic import that failed, then rethrows to the caller, which reports the
// failure under its own step. Here it is only the reload offer and a breadcrumb with one count in front of that report.

import { reportExpected, spans as S } from '@dotli/metrics';
import type { ShowNotification } from './notification.js';

export interface ChunkFailureDeps {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  notify: ShowNotification;
  reload: () => void;
}

/** Offers a reload after a part of the page failed to load, most likely because a new version was deployed. */
export function offerReload(notify: ShowNotification, reload: () => void): void {
  // The user opts into a reload rather than getting a silent one.
  notify({
    label: 'Asset failed to load',
    text: 'A new version may have been deployed. Reload to get the latest.',
    tone: 'err',
    dismissMs: 0,
    action: { label: 'Reload', onClick: reload },
  });
}

/** Offers a reload for each chunk that fails to load, until the returned stop. */
export function listenForChunkFailures({ target, notify, reload }: ChunkFailureDeps): () => void {
  const onPreloadError = (event: Event): void => {
    const error = (event as Event & { payload?: unknown }).payload ?? new Error('vite:preloadError');
    // The caller that imported the chunk reports the failure, so here it is a breadcrumb and one count.
    reportExpected(error, { flow: 'boot', step: 'chunk_preload', metric: S.CHUNK_PRELOAD });
    offerReload(notify, reload);
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError);
  };
}
