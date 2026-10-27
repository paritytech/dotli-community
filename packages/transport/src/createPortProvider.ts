// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createListeners } from './createListeners.js';
import type { PortLike, Provider } from './provider.js';
import { toTransferableBuffer } from './toTransferableBuffer.js';

type Params = {
  /** The port the provider posts on and hears from. */
  port: PortLike;
  /** Unset or true, `dispose` closes the port. False leaves the port open for its owner to close. */
  closeOnDispose?: boolean;
};

/**
 * Starts the port, so it hears from the moment it is created and delivers only to listeners subscribed by then. It
 * posts and accepts an `ArrayBuffer` on the port.
 */
export function createPortProvider({ port, closeOnDispose = true }: Params): Provider {
  const listeners = createListeners();

  port.addEventListener('message', handleMessage);
  port.start();

  return {
    isCorrectEnvironment: () => true,
    postMessage(message) {
      if (listeners.isDisposed()) {
        throw new Error('The provider is disposed');
      }
      const buffer = toTransferableBuffer(message);
      port.postMessage(buffer, [buffer]);
    },
    subscribe: listeners.subscribe,
    dispose() {
      if (!listeners.dispose()) {
        return;
      }
      port.removeEventListener('message', handleMessage);
      if (closeOnDispose) {
        port.close();
      }
    },
  };

  function handleMessage(event: { readonly data: unknown }): void {
    if (event.data instanceof ArrayBuffer) {
      listeners.deliver(new Uint8Array(event.data));
    }
  }
}
