// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createListeners } from './createListeners.js';
import type { MessageTarget, Provider, WindowLike, WindowMessage } from './provider.js';
import { toTransferableBuffer } from './toTransferableBuffer.js';

/** What a window provider listens on, posts to and admits. */
export type WindowProviderParams = {
  /** Where the provider hears messages. */
  listen: MessageTarget;
  /** The peer window, or null once it is gone. */
  peer: () => WindowLike | null;
  /**
   * A fixed origin, or a predicate whose first origin to send bytes is locked for the rest of the provider's life. Only
   * bytes from the admitted origin are delivered, so this is the trust boundary of every method served over it.
   */
  origin: string | ((origin: string) => boolean);
  /** Called for data from the admitted peer that is not an `ArrayBuffer`. */
  onNotBytes?: () => void;
  /**
   * Called for bytes from any window at an origin this provider does not admit, so a page outside the trust boundary
   * that tries to speak the wire is seen. Other data from such an origin is not the wire and goes unreported.
   */
  onRefusedOrigin?: (origin: string) => void;
};

/**
 * Hears its peer from the moment it is created, and delivers only to listeners subscribed by then. Between documents
 * it posts and accepts an `ArrayBuffer`.
 */
export function createWindowProvider({
  listen,
  peer,
  origin,
  onNotBytes,
  onRefusedOrigin,
}: WindowProviderParams): Provider {
  const listeners = createListeners();
  let locked: string | null = typeof origin === 'string' ? origin : null;

  listen.addEventListener('message', handleMessage);

  return {
    isCorrectEnvironment() {
      // A page with no parent is its own parent, as a frame app opened at the top is, and has no peer to talk to.
      const self: object = listen;
      return peer() !== self;
    },
    postMessage(message) {
      if (listeners.isDisposed()) {
        throw new Error('The provider is disposed');
      }
      const target = peer();
      if (target === null) {
        throw new Error('The peer window is gone');
      }
      if (locked === null) {
        throw new Error('No peer origin is admitted yet');
      }
      const buffer = toTransferableBuffer(message);
      target.postMessage(buffer, locked, [buffer]);
    },
    subscribe: listeners.subscribe,
    dispose() {
      if (listeners.dispose()) {
        listen.removeEventListener('message', handleMessage);
      }
    },
  };

  function handleMessage(event: WindowMessage): void {
    const { data } = event;
    const admitted = locked === null ? typeof origin !== 'string' && origin(event.origin) : event.origin === locked;
    if (!admitted) {
      if (data instanceof ArrayBuffer) {
        onRefusedOrigin?.(event.origin);
      }
      return;
    }
    const source = peer();
    if (source === null || event.source !== source) {
      return;
    }
    if (!(data instanceof ArrayBuffer)) {
      onNotBytes?.();
      return;
    }
    // Only bytes lock the origin, so an object from an allowed origin leaves the lock to the peer that speaks the wire.
    locked ??= event.origin;
    listeners.deliver(new Uint8Array(data));
  }
}
