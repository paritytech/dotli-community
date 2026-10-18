// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// truapi's `Result` and `CallError`. A `Result` is scale-ts's own. A `CallError` is the method's own `Domain` error or a
// failure of the library's, and the library's failures are an enum of their own, so the library answers any call with
// one whatever the method's error is.

import { Enum, Struct, _void, str, type Codec, type CodecType, type ResultPayload } from 'scale-ts';
import { failureReason } from './errors.js';

/** A record's entries as a tagged union, the shape a scale-ts `Enum` reads and writes. */
export type Variant<T> = { [K in keyof T]: { tag: K; value: T[K] } }[keyof T];

/** Wraps a value as a success. Called with no argument it is the success of a call that returns nothing. */
export function ok(): ResultPayload<undefined, never>;
export function ok<T>(value: T): ResultPayload<T, never>;
export function ok<T>(value?: T): ResultPayload<T | undefined, never> {
  return { success: true, value };
}

/** Wraps an error as a failure. */
export function err<E>(error: E): ResultPayload<never, E> {
  return { success: false, value: error };
}

const reason = Struct({ reason: str });

const failures = {
  Denied: _void,
  Unsupported: _void,
  MalformedFrame: reason,
  HostFailure: reason,
  Cancelled: _void,
};

/** A failure of the library's own. `Cancelled` is raised by the caller's own side when it aborts. */
export const failure = Enum(failures);

export type Failure = CodecType<typeof failure>;

/** Why a call did not return its value: the method's own `Domain` error, or a failure of the library's. */
export type CallError<E> = { tag: 'Domain'; value: E } | Failure;

/** truapi's `CallError`, with `Domain` first. */
export const callError = <E>(domain: Codec<E>): Codec<CallError<E>> => Enum({ Domain: domain, ...failures });

export const domain = <E>(value: E): CallError<E> => ({ tag: 'Domain', value });
export const denied = (): Failure => ({ tag: 'Denied', value: undefined });
export const unsupported = (): Failure => ({ tag: 'Unsupported', value: undefined });
export const malformedFrame = (why: string): Failure => ({ tag: 'MalformedFrame', value: { reason: why } });
/**
 * A handler's failure. Given an `Error`, the reason is the one a handler that throws it answers with, `"<name>:
 * <message>"`, bounded. truapi's `HostFailure` has one reason and no name, so the name rides in it.
 */
export const hostFailure = (why: string | Error): Failure => ({
  tag: 'HostFailure',
  value: { reason: typeof why === 'string' ? why : failureReason(why) },
});
export const cancelled = (): Failure => ({ tag: 'Cancelled', value: undefined });
