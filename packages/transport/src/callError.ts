// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// truapi's `CallError`: the method's own `Domain` error or a failure of the library's.

import { Enum, type Codec } from 'scale-ts';
import { failures, type Failure } from './failure.js';

/** Why a call did not return its value: the method's own `Domain` error, or a failure of the library's. */
export type CallError<Domain> = { tag: 'Domain'; value: Domain } | Failure;

/**
 * truapi's `CallError`, with `Domain` first. A request's answer carries one, as does an interrupt that chooses it.
 *
 * @example
 * const interrupt = Result(_void, callError(str));
 * const failed: CallError<string> = domain('no such account');
 */
export function callError<Domain>(domain: Codec<Domain>): Codec<CallError<Domain>> {
  return Enum({ Domain: domain, ...failures });
}

/** Fails a call with the method's own error. */
export function domain<Domain>(value: Domain): CallError<Domain> {
  return { tag: 'Domain', value };
}
