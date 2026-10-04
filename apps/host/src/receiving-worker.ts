// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />

import { installBrowserReceivingWorker } from '@parity/truapi-host/browser-receiving-worker';
import init, { WasmNotificationReceiver } from '@parity/truapi-host/wasm/web';

declare const __RECEIVING_RELAY_URL__: string;
declare const __RECEIVING_PUSH_ORIGIN__: string;
declare const __RECEIVING_WASM_URL__: string;

const scope = self as unknown as ServiceWorkerGlobalScope;

// No competing registration, signing host, wallet, product code, or dynamic
// module loading. Workbox imports this classic bundle into /host-sw.js.
if (__RECEIVING_RELAY_URL__ && __RECEIVING_PUSH_ORIGIN__) {
  if (__RECEIVING_PUSH_ORIGIN__ !== scope.location.origin || !scope.navigator.locks) {
    console.warn('[dot.li] Background receiving unsupported: origin mismatch or Web Locks unavailable');
  } else {
    let initialized: Promise<void> | undefined;
    installBrowserReceivingWorker({
      scope,
      relayUrl: __RECEIVING_RELAY_URL__,
      pushOrigin: __RECEIVING_PUSH_ORIGIN__,
      hostEntryUrl: '/',
      notificationTitle: 'Polkadot Web',
      createReceiver: async callbacks => {
        // The canonical installer has already applied
        // createNotificationReceiverCallbacks (typed domain -> raw SCALE).
        // Applying it twice would encode authority/consent records twice.
        initialized ??= init({ module_or_path: new URL(__RECEIVING_WASM_URL__, scope.location.origin) }).then(
          () => undefined,
          (error: unknown) => {
            initialized = undefined;
            throw error;
          },
        );
        await initialized;
        return new WasmNotificationReceiver(callbacks);
      },
    });
  }
} else {
  console.info('[dot.li] Background receiving unsupported: relay URL and push origin are not configured');
}
