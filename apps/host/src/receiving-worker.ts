// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />

import { installBrowserReceivingWorker } from '@parity/truapi-host/browser-receiving-worker';
import init, { WasmNotificationReceiver } from '@parity/truapi-host/wasm/web';
import { receivingConfigForOrigin, type ReceivingOriginConfig } from '@dotli/config/receiving';

declare const __RECEIVING_ORIGINS__: readonly ReceivingOriginConfig[];
declare const __RECEIVING_WASM_URL__: string;

const scope = self as unknown as ServiceWorkerGlobalScope;
const config = receivingConfigForOrigin(__RECEIVING_ORIGINS__, scope.location.origin);

// No competing registration, signing host, wallet, product code, or dynamic
// module loading. Workbox imports this classic bundle into /host-sw.js.
if (config) {
  if (!('locks' in scope.navigator)) {
    console.warn('[dot.li] Background receiving unsupported: Web Locks unavailable');
  } else {
    let initialized: Promise<void> | undefined;
    installBrowserReceivingWorker({
      scope,
      relayUrl: config.relayUrl,
      pushOrigin: config.origin,
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
  console.warn('[dot.li] Background receiving unsupported: this exact origin is not configured');
}
