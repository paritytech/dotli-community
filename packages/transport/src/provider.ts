// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Providers move bytes between two contexts and know nothing about their meaning. The transport above them encodes and
// decodes messages.

/** A message a window delivers, as much of it as the window provider reads. A `MessageEvent` is one. */
export interface WindowMessage {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

/** Where a window provider hears messages. The page's `window` in the browser. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: WindowMessage) => void): void;
  removeEventListener(type: 'message', listener: (event: WindowMessage) => void): void;
}

export interface Provider {
  /**
   * Transfers the buffer to the peer, so the caller must not reuse it. Throws after `dispose`. It never delivers to its
   * own listeners before it returns, the peer's reply included, as `postMessage` and message ports do, so a caller may
   * record what it posted once `post` returns.
   */
  post(data: ArrayBuffer): void;
  /**
   * Hears each message that arrives while the listener is subscribed. A provider holds nothing for a listener yet to
   * come, so its owner subscribes in the turn that creates it. Does nothing after `dispose`.
   */
  subscribe(listener: (data: ArrayBuffer) => void): () => void;
  /** The origin the peer is known by, or null when it has none or none is admitted yet. */
  peerOrigin(): string | null;
  dispose(): void;
}

export interface WindowLike {
  postMessage(message: ArrayBuffer, targetOrigin: string, transfer: Transferable[]): void;
}

/** A message port, as much of it as the port provider uses. A `MessagePort` is one. */
export interface PortLike {
  postMessage(message: ArrayBuffer, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
  close(): void;
}

export interface WindowProviderDeps {
  listen: MessageTarget;
  peer: () => WindowLike | null;
  /** A fixed origin, or a predicate whose first origin to send bytes is locked for the rest of the provider's life. */
  origin: string | ((origin: string) => boolean);
  /** Called for data from the admitted peer that is not an `ArrayBuffer`. */
  onNotBytes?: () => void;
  /**
   * Called for bytes from any window at an origin this provider does not admit, so a page outside the trust boundary
   * that tries to speak the wire is seen. Other data from such an origin is not the wire and goes unreported.
   */
  onRefusedOrigin?: (origin: string) => void;
}

/** A provider's listeners, which hear nothing once it is disposed. */
interface Listeners {
  deliver: (data: ArrayBuffer) => void;
  subscribe: (listener: (data: ArrayBuffer) => void) => () => void;
  /** Drops every listener. Returns false when already disposed. */
  dispose: () => boolean;
  disposed: () => boolean;
}

function createListeners(): Listeners {
  const listeners = new Set<(data: ArrayBuffer) => void>();
  let disposed = false;
  return {
    deliver: data => {
      for (const listener of [...listeners]) {
        // A listener may dispose the provider, after which the rest hear nothing.
        if (disposed) {
          return;
        }
        listener(data);
      }
    },
    subscribe: listener => {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
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

/** Hears its peer from the moment it is created, and delivers only to listeners subscribed by then. */
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
    listeners.deliver(data);
  };
  listen.addEventListener('message', onMessage);

  return {
    post(data) {
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
      target.postMessage(data, locked, [data]);
    },
    subscribe: listeners.subscribe,
    peerOrigin: () => locked,
    dispose() {
      if (listeners.dispose()) {
        listen.removeEventListener('message', onMessage);
      }
    },
  };
}

interface PortProviderOptions {
  /** Unset or true, `dispose` closes the port. False leaves the port open for its owner to close. */
  closeOnDispose?: boolean;
}

/** Starts the port, so it hears from the moment it is created and delivers only to listeners subscribed by then. */
export function createPortProvider(port: PortLike, options: PortProviderOptions = {}): Provider {
  const closeOnDispose = options.closeOnDispose ?? true;
  const listeners = createListeners();

  const onMessage = (event: { readonly data: unknown }): void => {
    if (event.data instanceof ArrayBuffer) {
      listeners.deliver(event.data);
    }
  };
  port.addEventListener('message', onMessage);
  port.start();

  return {
    post(data) {
      if (listeners.disposed()) {
        throw new Error('The provider is disposed');
      }
      port.postMessage(data, [data]);
    },
    subscribe: listeners.subscribe,
    peerOrigin: () => null,
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
