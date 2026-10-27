// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The library's own failures are an enum of their own, so the library answers any call with one whatever the method's
// error is.

import { Enum, Struct, _void, str, type CodecType } from 'scale-ts';
import { getFailureReason } from './getFailureReason.js';

/** The variants of a `Failure`, in wire order. */
export const failures = {
  Denied: _void,
  Unsupported: _void,
  MalformedFrame: Struct({ reason: str }),
  HostFailure: Struct({ reason: str }),
  Cancelled: _void,
};

/** A failure of the library's own. `Cancelled` is raised by the caller's own side when it aborts. */
export const failureCodec = Enum(failures);

/** A failure of the library's own, as its codec reads and writes it. */
export type Failure = CodecType<typeof failureCodec>;

/** The serving side denied the call. */
export function denied(): Failure {
  return { tag: 'Denied', value: undefined };
}

/** The serving side does not serve the method. */
export function unsupported(): Failure {
  return { tag: 'Unsupported', value: undefined };
}

/** A message that did not decode, or did not fit what it names. */
export function malformedFrame(why: string | Error): Failure {
  return { tag: 'MalformedFrame', value: createReason(why) };
}

/** A handler's failure. Given an `Error`, the reason is the one a handler that throws it answers with. */
export function hostFailure(why: string | Error): Failure {
  return { tag: 'HostFailure', value: createReason(why) };
}

/** The caller's own side cancelled the call. */
export function cancelled(): Failure {
  return { tag: 'Cancelled', value: undefined };
}

/**
 * A failure's reason. Given an `Error`, it is `"<name>: <message>"`, bounded. truapi's failures have one reason and no
 * name, so the name rides in it.
 */
function createReason(why: string | Error): { reason: string } {
  return { reason: typeof why === 'string' ? why : getFailureReason(why) };
}
