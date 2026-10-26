// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Providers move bytes between two contexts and know nothing about their meaning. The transport above them encodes and
// decodes messages.

/** A message a window delivers, as much of it as the window provider reads. A `MessageEvent` is one. */
export type WindowMessage = {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
};

/** Where a window provider hears messages. The page's `window` in the browser. */
export type MessageTarget = {
  addEventListener(type: 'message', listener: (event: WindowMessage) => void): void;
  removeEventListener(type: 'message', listener: (event: WindowMessage) => void): void;
};

export type Provider = {
  /** Whether this context has a peer to talk to. A transport over a provider that has none closes at once. */
  isCorrectEnvironment(): boolean;
  /**
   * Transfers the message's bytes to the peer, so the caller must not reuse the message. Throws after `dispose`. It
   * never delivers to its own subscribers before it returns, the peer's reply included, as `postMessage` and message
   * ports do, so a caller may record what it posted once `postMessage` returns.
   */
  postMessage(message: Uint8Array): void;
  /**
   * Hears each message that arrives while the callback is subscribed. A provider holds nothing for a callback yet to
   * come, so its owner subscribes in the turn that creates it. Does nothing after `dispose`.
   */
  subscribe(callback: (message: Uint8Array) => void): () => void;
  dispose(): void;
};

export type WindowLike = {
  postMessage(message: ArrayBuffer, targetOrigin: string, transfer: Transferable[]): void;
};

/** A message port, as much of it as the port provider uses. A `MessagePort` is one. */
export type PortLike = {
  postMessage(message: ArrayBuffer, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
  close(): void;
};

export type WindowProviderDeps = {
  listen: MessageTarget;
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

/** A provider's listeners, which hear nothing once it is disposed. */
export type Listeners = {
  deliver: (message: Uint8Array) => void;
  subscribe: (callback: (message: Uint8Array) => void) => () => void;
  /** Drops every listener. Returns false when already disposed. */
  dispose: () => boolean;
  disposed: () => boolean;
};

export function createListeners(): Listeners {
  const listeners = new Set<(message: Uint8Array) => void>();
  let disposed = false;
  return {
    deliver: message => {
      for (const listener of [...listeners]) {
        // A listener may dispose the provider, after which the rest hear nothing.
        if (disposed) {
          return;
        }
        listener(message);
      }
    },
    subscribe: callback => {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    dispose: () => {
      if (disposed) {
        return false;
      }
      disposed = true;
      listeners.clear();
      return true;
    },
    disposed: () => disposed,
  };
}

/**
 * The message's bytes in a buffer that holds only them, so transferring it moves nothing else. The message's own buffer
 * when it fits exactly, and a copy of a view into a larger one.
 */
export function transferableBuffer(message: Uint8Array): ArrayBuffer {
  const { buffer } = message;
  return buffer instanceof ArrayBuffer && message.byteOffset === 0 && message.byteLength === buffer.byteLength
    ? buffer
    : message.slice().buffer;
}

/**
 * Hears its peer from the moment it is created, and delivers only to listeners subscribed by then. Between documents
 * it posts and accepts an `ArrayBuffer`.
 */
export function createWindowProvider(deps: WindowProviderDeps): Provider {
  const { listen, peer, origin, onNotBytes, onRefusedOrigin } = deps;
  const listeners = createListeners();
  let locked: string | null = typeof origin === 'string' ? origin : null;

  const onMessage = (event: WindowMessage): void => {
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
  };
  listen.addEventListener('message', onMessage);

  return {
    isCorrectEnvironment() {
      // A page with no parent is its own parent, as a frame app opened at the top is, and has no peer to talk to.
      const self: object = listen;
      return peer() !== self;
    },
    postMessage(message) {
      if (listeners.disposed()) {
        throw new Error('The provider is disposed');
      }
      const target = peer();
      if (target === null) {
        throw new Error('The peer window is gone');
      }
      if (locked === null) {
        throw new Error('No peer origin is admitted yet');
      }
      const buffer = transferableBuffer(message);
      target.postMessage(buffer, locked, [buffer]);
    },
    subscribe: listeners.subscribe,
    dispose() {
      if (listeners.dispose()) {
        listen.removeEventListener('message', onMessage);
      }
    },
  };
}

type PortProviderOptions = {
  /** Unset or true, `dispose` closes the port. False leaves the port open for its owner to close. */
  closeOnDispose?: boolean;
};

/**
 * Starts the port, so it hears from the moment it is created and delivers only to listeners subscribed by then. It
 * posts and accepts an `ArrayBuffer` on the port.
 */
export function createPortProvider(port: PortLike, options: PortProviderOptions = {}): Provider {
  const closeOnDispose = options.closeOnDispose ?? true;
  const listeners = createListeners();

  const onMessage = (event: { readonly data: unknown }): void => {
    if (event.data instanceof ArrayBuffer) {
      listeners.deliver(new Uint8Array(event.data));
    }
  };
  port.addEventListener('message', onMessage);
  port.start();

  return {
    isCorrectEnvironment: () => true,
    postMessage(message) {
      if (listeners.disposed()) {
        throw new Error('The provider is disposed');
      }
      const buffer = transferableBuffer(message);
      port.postMessage(buffer, [buffer]);
    },
    subscribe: listeners.subscribe,
    dispose() {
      if (!listeners.dispose()) {
        return;
      }
      port.removeEventListener('message', onMessage);
      if (closeOnDispose) {
        port.close();
      }
    },
  };
}
