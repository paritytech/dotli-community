// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Runs TrUAPI calls over one leased connection to the page core. */

import { createTransport, type CallErrorValue, type TrUApiTransport, type UnsupportedCallError } from '@parity/truapi';
import { ownCoreConnection } from '../core-connection.js';
import type { CoreConnection } from '../page-core.js';

/** A call error whose domain error sits in a versioned envelope, as every TrUAPI method's does. */
export type SiteCallError = CallErrorValue<{ tag: string; value: { tag: string } }> | UnsupportedCallError;

export interface CoreCallsDeps {
  acquire: () => Promise<{ connect(): Promise<CoreConnection>; release(): void }>;
}

/**
 * Runs `use` over one lease and one connection to the core, which it closes and releases after. A request may wait on
 * the phone for `requestTimeoutMs`.
 */
export async function withCoreCalls<T>(
  deps: CoreCallsDeps,
  requestTimeoutMs: number,
  use: (calls: { transport: TrUApiTransport }) => Promise<T>,
): Promise<T> {
  const lease = await deps.acquire();
  try {
    const connection = await lease.connect();
    const provider = ownCoreConnection(connection);
    const transport = createTransport(provider, { requestTimeoutMs });
    try {
      return await use({ transport });
    } finally {
      transport.dispose();
      provider.dispose();
    }
  } finally {
    lease.release();
  }
}
