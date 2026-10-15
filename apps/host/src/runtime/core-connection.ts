// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A connection to the page core as the product and the topbar login use it, with every frame shown to the debug panel.

import { decodeWireMessage, type WireProvider } from '@parity/truapi';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { reportListener } from '@dotli/metrics';
import { createLazyLoad, createListenerSet, noop } from '@dotli/shared';
import { emitDotliDebugEvent, hasDotliDebugListeners } from '@dotli/truapi-debug';
import { loadWireDescriber } from '../lazy.js';
import { reportLazyMiss } from '../lazy-miss.js';
import type { CoreConnection } from './page-core.js';
import { getWalletMode } from './state/wallet-mode.js';

export type CoreProvider = WireProvider &
  Pick<
    TrUApiProductProvider,
    'getPermissionAuthorizationStatus' | 'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
  >;

/**
 * The describer's chunk, loaded one load at a time, so frames reach the panel in the order they crossed. A failed load
 * rejects that frame and the next frame loads again, while only the first miss of the page is reported.
 */
export function createWireDescriber(load: typeof loadWireDescriber): {
  preload: () => ReturnType<typeof loadWireDescriber>;
} {
  return {
    preload: createLazyLoad(load, {
      onFirstMiss: err => {
        reportLazyMiss('ui', 'wire_describe_load', err);
      },
    }),
  };
}

const wireDescriber = createWireDescriber(loadWireDescriber);

/** Started with debug mode, so the first frames are not held back by the chunk. */
export function preloadWireDescriber(): ReturnType<typeof loadWireDescriber> {
  return wireDescriber.preload();
}

function emitWireFrameDebug(direction: 'incoming' | 'outgoing', productId: string, message: Uint8Array): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    return;
  }
  const { requestId, payload } = decoded.value;
  const decodeWalletFrames = getWalletMode() === 'local';
  // Off the transport path: a panel listener that throws becomes a rejection the page reports, and delivery goes on.
  void preloadWireDescriber().then(
    ({ describeWireFrame }) => {
      emitDotliDebugEvent({
        kind: 'truapi',
        direction,
        productId,
        requestId,
        payload: describeWireFrame(payload, payload.value, { decodeWalletFrames }),
      });
    },
    () => {
      // Reported once where it loads.
    },
  );
}

/**
 * Takes over `connection`: the provider shows every frame to the debug panel, and its dispose closes the connection,
 * which the page core reads as deliberate.
 */
export function ownCoreConnection(connection: CoreConnection): CoreProvider {
  const { provider, productId } = connection;
  const listeners = createListenerSet<Uint8Array>({
    onListenerError: reportListener('wallet', 'core_connection.frame'),
  });
  let disposed = false;
  const unsubscribeCore = provider.subscribe(message => {
    if (disposed) {
      return;
    }
    emitWireFrameDebug('outgoing', productId, message);
    listeners.emit(message);
  });

  return {
    postMessage(message: Uint8Array): void {
      if (disposed) {
        return;
      }
      emitWireFrameDebug('incoming', productId, message);
      provider.postMessage(message);
    },
    subscribe(callback) {
      return listeners.subscribe(callback);
    },
    subscribeClose(callback) {
      return provider.subscribeClose?.(callback) ?? noop;
    },
    getPermissionAuthorizationStatus(request) {
      return provider.getPermissionAuthorizationStatus(request);
    },
    getPermissionAuthorizationStatuses(requests) {
      return provider.getPermissionAuthorizationStatuses(requests);
    },
    setPermissionAuthorizationStatus(request, status) {
      return provider.setPermissionAuthorizationStatus(request, status);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeCore();
      connection.close();
    },
  };
}
