// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Vite's preload helper reports every dynamic import that failed, then rethrows to the caller, which reports the
// failure under its own step. Here it is only the reload offer and a breadcrumb in front of that report.

import type { ShowNotification } from './notification.js';

export interface ChunkFailureDeps {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  notify: ShowNotification;
  reload: () => void;
  /** The app leaves the failure as an expected breadcrumb under its own metric. */
  report: (error: unknown) => void;
}

/** Offers a reload for each chunk that fails to load, until the returned stop. */
export function listenForChunkFailures({ target, notify, reload, report }: ChunkFailureDeps): () => void {
  const onPreloadError = (event: Event): void => {
    report((event as Event & { payload?: unknown }).payload ?? new Error('vite:preloadError'));
    // The user opts into a reload rather than getting a silent one.
    notify({
      label: 'Asset failed to load',
      text: 'A new version may have been deployed. Reload to get the latest.',
      tone: 'err',
      dismissMs: 0,
      action: { label: 'Reload', onClick: reload },
    });
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError);
  };
}
