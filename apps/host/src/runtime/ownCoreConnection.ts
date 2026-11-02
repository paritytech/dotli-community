// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A connection to the page core, with every frame shown to the debug panel.

import type { WireProvider } from '@parity/truapi';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { reportListener } from '@dotli/metrics';
import { createListenerSet, noop } from '@dotli/shared';
import type { CoreConnection } from './createPageCore.js';
import { emitWireFrameDebug } from './createWireDescriber.js';

export type CoreProvider = WireProvider &
  Pick<
    TrUApiProductProvider,
    'getPermissionAuthorizationStatus' | 'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
  >;

/**
 * Takes over `connection`: the provider shows every frame to the debug panel, and its dispose closes the connection
 * through its `close`, as a deliberate close. Never throws.
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
    emitWireFrameDebug({ direction: 'outgoing', productId, message });
    listeners.emit(message);
  });

  return {
    postMessage(message: Uint8Array): void {
      if (disposed) {
        return;
      }
      emitWireFrameDebug({ direction: 'incoming', productId, message });
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
