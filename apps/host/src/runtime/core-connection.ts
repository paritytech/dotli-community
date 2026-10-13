// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A connection to the page core as the product and the topbar login use it, with every frame shown to the debug panel.

import { decodeWireMessage, type WireProvider } from '@parity/truapi';
import type { TrUApiProductProvider } from '@parity/truapi-host';
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

const noop = (): void => undefined;

/** One load of the describer for the page. A failed load is reported once and kept, since a deploy replaced the chunk. */
export function createWireDescriber(load: typeof loadWireDescriber): {
  preload: () => ReturnType<typeof loadWireDescriber>;
} {
  // Every frame waits on the same load, so frames reach the panel in the order they crossed.
  let loaded: ReturnType<typeof loadWireDescriber> | undefined;
  return {
    preload: () =>
      (loaded ??= load().catch((err: unknown) => {
        reportLazyMiss('ui', 'wire_describe_load', err);
        throw err;
      })),
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

/** Disposing it closes the connection, which the page core reads as deliberate. */
export function wrapCoreProviderForDebug(connection: CoreConnection): CoreProvider {
  const { provider, productId } = connection;
  const listeners = new Set<(message: Uint8Array) => void>();
  let disposed = false;
  const unsubscribeCore = provider.subscribe(message => {
    if (disposed) {
      return;
    }
    emitWireFrameDebug('outgoing', productId, message);
    for (const listener of [...listeners]) {
      listener(message);
    }
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
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
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
      listeners.clear();
      connection.close();
    },
  };
}
