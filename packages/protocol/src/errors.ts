// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export class ProtocolFatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolFatalError';
  }
}

export class ProtocolInitFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolInitFailedError';
  }
}

/** The peer speaks another wire version. Rebuilding cannot fix it, and a reload loads the matching build. */
export class ProtocolVersionMismatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolVersionMismatchError';
  }
}

/** The peer never answered the handshake while the page was running. */
export class ProtocolHandshakeTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolHandshakeTimeoutError';
  }
}

/** The SharedWorker let go of a tab's port, so everything open on it ended. */
export class ProtocolPortReleasedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolPortReleasedError';
  }
}

/**
 * A protocol request that failed across the iframe boundary, or never came back.
 *
 * The sender's error crosses as its name and message only, so this object's own stack says nothing. `method` carries
 * which request failed.
 */
export class ProtocolRequestError extends Error {
  readonly method: string;

  constructor(message: string, name: string, method: string) {
    super(message);
    this.name = name;
    this.method = method;
  }
}

/**
 * Frame lifecycle failures callers surface to the user.
 *
 * Plain strings, not `Error` subclasses, because the host's `describeError` matches on message
 * text and a new `name` would regroup them in Sentry.
 */
export const PROTOCOL_ERRORS = {
  FRAME_READY_TIMEOUT: 'Shared protocol iframe timed out (no ready signal)',
  HOST_FRAME_LOAD_TIMEOUT: 'Shared host iframe timed out while loading',
  HOST_FRAME_LOAD_FAILED: 'Shared host iframe failed to load',
  /** The frame stopped reporting its status without saying why, so nothing tells when it fails. */
  FRAME_STATUS_ENDED: 'Protocol frame stopped reporting its status',
  /** The frame ended a name resolution before it sent the result. */
  RESOLUTION_ENDED: 'Name resolution ended without a result',
  /** Fallback rejection when a reset carries no reason, so readiness waiters fail at once instead of timing out. */
  FRAME_RESET: 'Protocol frame state reset before ready signal',
  /** Nothing said how to build the frame, as on a page that never configures it. */
  FRAME_UNCONFIGURED: 'Protocol frame was never configured',
} as const;
