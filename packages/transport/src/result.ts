// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok(value?: unknown): Result<unknown, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Why a call did not return its value. `Domain` carries the handler's own error, the rest are the library's. */
export type CallError<E> =
  | { tag: 'Domain'; value: E }
  | { tag: 'Denied' }
  | { tag: 'Unsupported' }
  | { tag: 'MalformedFrame'; reason: string }
  | { tag: 'HostFailure'; reason: string }
  | { tag: 'Cancelled' };

export const domain = <E>(value: E): CallError<E> => ({ tag: 'Domain', value });
export const denied = (): CallError<never> => ({ tag: 'Denied' });
export const unsupported = (): CallError<never> => ({ tag: 'Unsupported' });
export const malformedFrame = (reason: string): CallError<never> => ({ tag: 'MalformedFrame', reason });
export const hostFailure = (reason: string): CallError<never> => ({ tag: 'HostFailure', reason });
export const cancelled = (): CallError<never> => ({ tag: 'Cancelled' });
