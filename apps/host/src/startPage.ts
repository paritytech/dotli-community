// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What every page runs first: the page's stylesheet, then, on the call, the failure offers, the desktop offer and the
// wasm timings.

import '@dotli/ui/styles.css';
import { m } from '@dotli/metrics';
import { createReloadOffer, listenForChunkFailures, modals, showNotification } from '@dotli/ui';
import { isMobileDevice } from './isMobileDevice.js';
import { offerDesktopApp } from './offerDesktopApp.js';
import { getPageStandIns, reportIslandErrors } from './reportIslandErrors.js';
import { pageLocalStorage } from '@dotli/shared';
import { markAndReload } from './createContinuation.js';
import { authControl } from './runtime/createAuthController.js';

/** Measured with a PerformanceObserver. */
const WASM_LOAD = 'wasm.load';

type Params = {
  /** False leaves out the desktop offer. */
  desktopOffer?: boolean;
};

/** What a page load starts first: the chunk and island failure offers, the desktop offer and the wasm timings. */
export function startPage({ desktopOffer = true }: Params = {}): void {
  // One offer for the page, so chunk and island failures never stack reload toasts.
  const offerReload = createReloadOffer({
    notify: showNotification,
    reload() {
      markAndReload('app_update');
    },
  });
  // Both last the page's life, so their stops go unused.
  listenForChunkFailures({ target: window, offerReload });
  reportIslandErrors({
    offerReload,
    standIns: getPageStandIns({
      disableAuthModal: authControl.disableModal,
      refuseModals() {
        modals.refuseAll();
      },
    }),
  });

  if (desktopOffer && !isMobileDevice()) {
    offerDesktopApp({
      storage: pageLocalStorage,
      notify: showNotification,
      downloadUrl: import.meta.env.VITE_DESKTOP_DOWNLOAD_URL,
    });
  }

  if (m.enabled && typeof PerformanceObserver !== 'undefined') {
    const wasmObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.name.endsWith('.wasm')) {
          const name = entry.name.split('/').pop() ?? 'unknown';
          m.distribution(WASM_LOAD, entry.duration, { unit: 'millisecond', attributes: { module: name } });
        }
      }
    });
    wasmObserver.observe({ type: 'resource', buffered: true });
  }
}
