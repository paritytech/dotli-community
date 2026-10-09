// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export class ProtocolFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolFatalError';
  }
}

export class ProtocolInitFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolInitFailedError';
  }
}

/**
 * A protocol request that failed across the iframe boundary, or never came back.
 *
 * The sender's error crosses postMessage as text, so this object's own stack says nothing.
 * `method` and `remoteStack` carry which request failed and where the sender threw.
 */
export class ProtocolRequestError extends Error {
  readonly method: string;
  readonly remoteStack: string | undefined;

  constructor(message: string, name: string, method: string, remoteStack?: string) {
    super(message);
    this.name = name;
    this.method = method;
    this.remoteStack = remoteStack;
  }
}

/**
 * Frame lifecycle failures callers surface to the user.
 *
 * Plain strings, not `Error` subclasses, because the host's `describeError` matches on message
 * text and a new `name` would regroup them in Sentry.
 */
export const PROTOCOL_ERRORS = {
  /** The iframe vanished between the readiness await and the post. */
  FRAME_UNAVAILABLE: 'Shared protocol iframe is unavailable',
  FRAME_READY_TIMEOUT: 'Shared protocol iframe timed out (no ready signal)',
  HOST_FRAME_LOAD_TIMEOUT: 'Shared host iframe timed out while loading',
  HOST_FRAME_LOAD_FAILED: 'Shared host iframe failed to load',
  /** Fallback rejection when a reset carries no reason, so readiness waiters fail at once instead of timing out. */
  FRAME_RESET: 'Protocol frame state reset before ready signal',
} as const;
