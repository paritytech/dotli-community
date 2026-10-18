// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { failureReason } from './errors.js';

/** The outcome of a call that can fail, told apart by its `ok` field. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Wraps a value as a success. Called with no argument it is the success of a call that returns nothing. */
export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok(value?: unknown): Result<unknown, never> {
  return { ok: true, value };
}

/** Wraps an error as a failure. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Why a call did not return its value, as truapi's `CallError`. `Domain` carries the handler's own error, the rest are
 * the library's. `Cancelled` is raised by the caller's own side when it aborts.
 */
export type CallError<E> =
  | { tag: 'Domain'; value: E }
  | { tag: 'Denied'; value: undefined }
  | { tag: 'Unsupported'; value: undefined }
  | { tag: 'MalformedFrame'; value: { reason: string } }
  | { tag: 'HostFailure'; value: { reason: string } }
  | { tag: 'Cancelled'; value: undefined };

// One constructor per variant, each building the plain tagged value.
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
