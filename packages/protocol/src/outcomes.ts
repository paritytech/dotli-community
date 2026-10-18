// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How a call's failure reaches host code. Each becomes the error host code has always seen, so its class and name keep
// matching the error screen, the metrics and the trail.

import { TransportHandshakeTimeoutError, TransportVersionMismatchError, type CallError } from '@dotli/transport';
import { toError } from '@dotli/shared';
import type { CallName } from './call-names.js';
import {
  ProtocolFatalError,
  ProtocolHandshakeTimeoutError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolRequestError,
  ProtocolVersionMismatchError,
} from './errors.js';
import type { FrameFailure, RemoteFailure } from './schema.js';

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
