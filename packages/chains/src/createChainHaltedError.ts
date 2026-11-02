// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept free of the pool and the broker, so a caller on an eager path can take this module without the rest of the
// package.

import { CHAIN_HALTED_ERROR_DATA } from '@dotli/shared';
import { createJsonRpcError } from './createJsonRpcError.js';

/** The JSON-RPC error a request gets when its chain halted under it, or none can be had after a halt. */
export function createChainHaltedError(): { code: number; message: string; data: string } {
  return { ...createJsonRpcError(null, 'Chain transport halted').error, data: CHAIN_HALTED_ERROR_DATA };
}
