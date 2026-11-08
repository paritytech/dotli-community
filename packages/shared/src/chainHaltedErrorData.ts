// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isRecord } from './isRecord.js';

/**
 * The `error.data` of a JSON-RPC answer to a request its chain halted under, which a client may retry on the rebuilt
 * chain.
 */
export const CHAIN_HALTED_ERROR_DATA = 'dotli:chain-halted';

/**
 * Whether a JSON-RPC error, or an error a client built from one (such as papi's `RpcError`), is the answer to a request
 * its chain halted under. Never throws.
 */
export function isChainHaltedRpcError(error: unknown): boolean {
  return isRecord(error) && error['data'] === CHAIN_HALTED_ERROR_DATA;
}
