// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Providers move bytes between two contexts and know nothing about their meaning. The transport above them encodes and
// decodes messages.

/** Moves a transport's bytes to and from its peer. */
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
  /** Stops hearing the peer and drops every subscriber. A second call does nothing. */
  dispose(): void;
};

/** A message a window delivers, as much of it as the window provider reads. A `MessageEvent` is one. */
export type WindowMessage = {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
};

/** Where a window provider hears messages. The page's `window` in the browser. */
export type MessageTarget = {
  /** Starts delivering each message to `listener`, as a window's own `addEventListener` does. */
  addEventListener(type: 'message', listener: (event: WindowMessage) => void): void;
  /** Stops delivering messages to `listener`, as a window's own `removeEventListener` does. */
  removeEventListener(type: 'message', listener: (event: WindowMessage) => void): void;
};

/** A window to post to, as much of it as the window provider uses. A browser's `Window` is one. */
export type WindowLike = {
  /** Posts `message` to the window at `targetOrigin`, transferring `transfer`, as a window's own `postMessage` does. */
  postMessage(message: ArrayBuffer, targetOrigin: string, transfer: Transferable[]): void;
};

/** A message port, as much of it as the port provider uses. A `MessagePort` is one. Each member is the port's own. */
export type PortLike = {
  /** Posts `message` to the other end, transferring `transfer`. */
  postMessage(message: ArrayBuffer, transfer: Transferable[]): void;
  /** Starts delivering each message to `listener`. */
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Stops delivering messages to `listener`. */
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Starts delivering the messages the port queued. */
  start(): void;
  /** Disconnects the port, so neither end hears the other. */
  close(): void;
};
