// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How a call's failure crosses and how it reaches host code. A frame types the failures the host branches on, and each
// becomes the error host code has always seen, so its class and name keep matching the error screen, the metrics and
// the trail.

import {
  TransportHandshakeTimeoutError,
  TransportVersionMismatchError,
  domain,
  hostFailure,
  type CallError,
  type DomainError,
  type MethodName,
  type TraitName,
} from '@dotli/transport';
import { errorMessage, errorName, toError } from '@dotli/shared';
import { callName, type CallName } from './call-names.js';
import {
  ProtocolFatalError,
  ProtocolHandshakeTimeoutError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolRequestError,
  ProtocolVersionMismatchError,
} from './errors.js';
import type { FrameFailure, ProtocolSchema, RemoteFailure } from './schema.js';

/** Every domain error the schema declares. */
export type DomainFailure = FrameFailure | RemoteFailure;

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

/** A handler's failure crosses as `"<name>: <message>"`, so its name survives. */
function splitReason(reason: string): { name: string; message: string } {
  const at = reason.indexOf(': ');
  return at < 0 ? { name: 'Error', message: reason } : { name: reason.slice(0, at), message: reason.slice(at + 2) };
}

function domainFailure(failure: DomainFailure, method: CallName): Error {
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
      const { name, message } = splitReason(error.reason);
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
      return new ProtocolRequestError(error.reason, 'MalformedFrame', method);
  }
}

/**
 * The failure of a call of `method` in `trait` as the error the protocol's own code sees, for a frame that waits on or
 * relays another frame's calls.
 */
export function failureOf<T extends TraitName<ProtocolSchema>, M extends MethodName<ProtocolSchema, T>>(
  trait: T,
  method: M,
  error: CallError<DomainError<ProtocolSchema, T, M>>,
): Error {
  // Every domain error the schema declares is a `DomainFailure`.
  return callFailure(error as CallError<DomainFailure>, callName(trait, method));
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
 * The typed failure of a resolver or chain error the host's error screen tells apart by name, or null for any other,
 * which crosses as the handler's own failure.
 */
export function remoteFailureOf(error: unknown): RemoteFailure | null {
  const name = errorName(error);
  if (name === 'NetworkSyncTimeoutError') {
    return { tag: 'syncTimeout', value: errorMessage(error) };
  }
  if (name === 'ApiStoppedError') {
    return { tag: 'apiStopped', value: errorMessage(error) };
  }
  return null;
}
