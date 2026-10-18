// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { failureReason } from './errors.js';

/** A record's entries as a tagged union, the shape a SCALE enum reads and writes. */
export type Variant<T> = { [K in keyof T]: { tag: K; value: T[K] } }[keyof T];

/** The outcome of a call that can fail, as truapi's `Result`. */
export type Result<T, E> = Variant<{ Ok: T; Err: E }>;

/** Wraps a value as a success. Called with no argument it is the success of a call that returns nothing. */
export function ok(): Result<undefined, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok<T>(value?: T): Result<T | undefined, never> {
  return { tag: 'Ok', value };
}

/** Wraps an error as a failure. */
export function err<E>(error: E): Result<never, E> {
  return { tag: 'Err', value: error };
}

/**
 * Why a call did not return its value, as truapi's `CallError`. `Domain` carries the handler's own error, the rest are
 * the library's. `Cancelled` is raised by the caller's own side when it aborts.
 */
export type CallError<E> = Variant<{
  Domain: E;
  Denied: undefined;
  Unsupported: undefined;
  MalformedFrame: { reason: string };
  HostFailure: { reason: string };
  Cancelled: undefined;
}>;

export const domain = <E>(value: E): CallError<E> => ({ tag: 'Domain', value });
export const denied = (): CallError<never> => ({ tag: 'Denied', value: undefined });
export const unsupported = (): CallError<never> => ({ tag: 'Unsupported', value: undefined });
export const malformedFrame = (reason: string): CallError<never> => ({ tag: 'MalformedFrame', value: { reason } });
/**
 * A handler's failure. Given an `Error`, the reason is the one a handler that throws it answers with, `"<name>:
 * <message>"`, bounded, so a peer reads the error's name back.
 */
export const hostFailure = (reason: string | Error): CallError<never> => ({
  tag: 'HostFailure',
  value: { reason: typeof reason === 'string' ? reason : failureReason(reason) },
});
export const cancelled = (): CallError<never> => ({ tag: 'Cancelled', value: undefined });
