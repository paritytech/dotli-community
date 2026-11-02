// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ResolverError } from './resolverError.js';

/** No finalized parachain block arrived in time. Fatal, so the host offers the trusted-provider retry. */
export class NetworkSyncTimeoutError extends ResolverError {
  override readonly name = 'NetworkSyncTimeoutError' as const;
  readonly chain: string;
  readonly timeoutMs: number;

  constructor(chain: string, timeoutMs: number) {
    super(`Sync to ${chain} timed out after ${(timeoutMs / 1000).toFixed(0)}s. Unable to reach peers.`);
    this.chain = chain;
    this.timeoutMs = timeoutMs;
  }
}
