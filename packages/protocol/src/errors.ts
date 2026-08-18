// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export class ProtocolFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolFatalError";
  }
}

export class ProtocolInitFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolInitFailedError";
  }
}

/**
 * Messages for the frame lifecycle failures callers surface to the user.
 *
 * Plain strings rather than `Error` subclasses: `describeError` in the host
 * matches on message text, and giving these their own `name` would silently
 * regroup them in Sentry. The two classes above predate this and keep their
 * names.
 */
export const PROTOCOL_ERRORS = {
  /** The iframe vanished between the readiness await and the post. */
  FRAME_UNAVAILABLE: "Shared protocol iframe is unavailable",
  /** The iframe loaded but never sent its ready signal. */
  FRAME_READY_TIMEOUT: "Shared protocol iframe timed out (no ready signal)",
  /** The host iframe's `load` event never fired. */
  HOST_FRAME_LOAD_TIMEOUT: "Shared host iframe timed out while loading",
  /** The host iframe fired `error` instead of `load`. */
  HOST_FRAME_LOAD_FAILED: "Shared host iframe failed to load",
  /**
   * Frame state was reset while callers were still waiting on readiness.
   *
   * The fallback rejection when the reset carries no reason of its own, so
   * waiters fail at once rather than hanging until their own timeout.
   */
  FRAME_RESET: "Protocol frame state reset before ready signal",
} as const;
