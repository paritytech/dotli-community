// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol's errors, how a call's failure crosses and how it reaches host code. A frame types the failures the host
// branches on, and each becomes the error host code has always seen, so its class and name keep matching the error
// screen, the metrics and the trail.

import {
  TransportHandshakeTimeoutError,
  TransportVersionMismatchError,
  domain,
  hostFailure,
  reasonParts,
  type AnyMethod,
  type CallError,
} from '@dotli/transport';
import { toError } from '@dotli/shared';
import { callName, type CallName } from './method-policy.js';
import type { DomainFailure, FrameFailure, RemoteFailure } from './schema.js';

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

/** The error a transport closed with, under the protocol's own class when it is one of the transport's. */
export function fromTransportError(error: Error): Error {
  if (error instanceof TransportVersionMismatchError) {
    return new ProtocolVersionMismatchError(error.message, { cause: error });
  }
  if (error instanceof TransportHandshakeTimeoutError) {
    return new ProtocolHandshakeTimeoutError(error.message, { cause: error });
  }
  return error;
}

function domainFailure(failure: DomainFailure, method: CallName): Error {
  if (failure === undefined) {
    return new ProtocolRequestError(`The frame failed the call "${method}"`, 'Domain', method);
  }
  switch (failure.tag) {
    case 'fatal':
      return new ProtocolFatalError(failure.value);
    case 'initFailed':
      return new ProtocolInitFailedError(failure.value);
    case 'released':
      return new ProtocolPortReleasedError(failure.value);
    case 'versionMismatch':
      return new ProtocolVersionMismatchError(failure.value);
    // The host's error screen tells these apart by name.
    case 'syncTimeout':
      return new ProtocolRequestError(failure.value, 'NetworkSyncTimeoutError', method);
    case 'apiStopped':
      return new ProtocolRequestError(failure.value, 'ApiStoppedError', method);
  }
}

/**
 * A call's failure as the error host code sees. A call this side gave up on through `signal` fails with the signal's
 * reason, as an `Error` itself or wrapped in one.
 */
export function callFailure(error: CallError<DomainFailure>, method: CallName, signal?: AbortSignal): Error {
  switch (error.tag) {
    case 'Domain':
      return domainFailure(error.value, method);
    case 'HostFailure': {
      // A handler's failure crosses with its name, so its name survives.
      const { name, message } = reasonParts(error.value.reason);
      return new ProtocolRequestError(message, name, method);
    }
    case 'Cancelled':
      return signal?.aborted === true
        ? toError(signal.reason)
        : new ProtocolRequestError(`The call "${method}" was cancelled`, 'Cancelled', method);
    case 'Denied':
      return new ProtocolRequestError(`The frame refused the call "${method}"`, 'Denied', method);
    case 'Unsupported':
      return new ProtocolRequestError(`The frame does not serve "${method}"`, 'Unsupported', method);
    case 'MalformedFrame':
      return new ProtocolRequestError(error.value.reason, 'MalformedFrame', method);
  }
}

/**
 * The failure of a call of `method` as the error the protocol's own code sees, for a frame that waits on or relays
 * another frame's calls.
 */
export function failureOf<E extends DomainFailure>(method: AnyMethod, error: CallError<E>): Error {
  return callFailure(error, callName(method));
}

/**
 * How a frame ends its status on `error`: typed for a fatal, a failed init, a released port or a version mismatch, so
 * the host tells them apart, and as the error's own failure for any other. A transport's own closing error counts as
 * the protocol's.
 */
export function frameStatusEnd(closing: Error): CallError<FrameFailure> {
  const error = fromTransportError(closing);
  if (error instanceof ProtocolFatalError) {
    return domain({ tag: 'fatal', value: error.message });
  }
  if (error instanceof ProtocolInitFailedError) {
    return domain({ tag: 'initFailed', value: error.message });
  }
  if (error instanceof ProtocolPortReleasedError) {
    return domain({ tag: 'released', value: error.message });
  }
  if (error instanceof ProtocolVersionMismatchError) {
    return domain({ tag: 'versionMismatch', value: error.message });
  }
  return hostFailure(error);
}

/**
 * How a resolver or chain error ends a call: typed for the two the host's error screen tells apart by name, and as the
 * handler's own failure for any other.
 */
export function remoteEnd(error: Error): CallError<RemoteFailure> {
  switch (error.name) {
    case 'NetworkSyncTimeoutError':
      return domain({ tag: 'syncTimeout', value: error.message });
    case 'ApiStoppedError':
      return domain({ tag: 'apiStopped', value: error.message });
    default:
      return hostFailure(error);
  }
}
