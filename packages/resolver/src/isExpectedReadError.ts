// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { DisjointError, OperationInaccessibleError, OperationLimitError } from '@polkadot-api/substrate-client';
import { isChainHaltedRpcError } from '@dotli/shared';
import { isApiStoppedError } from './apiStoppedError.js';
import { NetworkSyncTimeoutError } from './networkSyncTimeoutError.js';

/**
 * Whether a dotNS read failed as the environment makes it: a sync timeout, an operation the server refused or no peer
 * served, a follow that stopped or went disjoint, or a chain that kept halting.
 */
export function isExpectedReadError(error: unknown): boolean {
  return (
    error instanceof NetworkSyncTimeoutError ||
    error instanceof OperationInaccessibleError ||
    error instanceof OperationLimitError ||
    error instanceof DisjointError ||
    isApiStoppedError(error) ||
    isChainHaltedRpcError(error)
  );
}
