// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs TrUAPI calls over one leased connection to the page core. A core that still restores its session answers as not
 * signed in, so a call that throws {@link CoreRestoringError} is retried for a while.
 */

import { createTransport, type CallErrorValue, type TrUApiTransport, type UnsupportedCallError } from '@parity/truapi';
import { createAsyncTaskPool, realTimers, type AsyncTaskPool, type Timers } from '@dotli/shared';
import { ownCoreConnection } from '../core-connection.js';
import type { CoreConnection } from '../page-core.js';

/** A call error whose domain error sits in a versioned envelope, as every TrUAPI method's does. */
export type SiteCallError = CallErrorValue<{ tag: string; value: { tag: string } }> | UnsupportedCallError;

export interface CoreCallsDeps {
  acquire: () => Promise<{ connect(): Promise<CoreConnection>; release(): void }>;
  /** The timers retry waits run on. The page's own by default. */
  timers?: Timers;
}

/** Retries over about 31 seconds, which a core restoring its session at page load fits in. */
const RESTORE_RETRIES = 6;
const RESTORE_FIRST_DELAY_MS = 500;

/** An answer that means the core has not restored its session yet, the one failure a call's retry pool tries again. */
export class CoreRestoringError extends Error {
  override name = 'CoreRestoringError';
  readonly error: SiteCallError;

  constructor(error: SiteCallError) {
    super('The core has not restored its session yet');
    this.error = error;
  }
}

/** What one connection to the core offers a call: its transport, the product it connects as, and its retry pool. */
export interface CoreCalls {
  transport: TrUApiTransport;
  productId: string;
  /** Retries a task that throws {@link CoreRestoringError} for a while. */
  restores: AsyncTaskPool;
}

/**
 * Runs `use` over one lease and one connection to the core, which it closes and releases after. A request may wait on
 * the phone for `requestTimeoutMs`.
 */
export async function withCoreCalls<T>(
  deps: CoreCallsDeps,
  requestTimeoutMs: number,
  use: (calls: CoreCalls) => Promise<T>,
): Promise<T> {
  // Each call retries on its own, so one waiting on the phone holds no other back.
  const restores = createAsyncTaskPool({
    poolSize: 1,
    retryCount: RESTORE_RETRIES,
    retryDelay: retry => RESTORE_FIRST_DELAY_MS * 2 ** retry,
    retryIf: error => error instanceof CoreRestoringError,
    timers: deps.timers ?? realTimers,
  });
  const lease = await deps.acquire();
  try {
    const connection = await lease.connect();
    const provider = ownCoreConnection(connection);
    const transport = createTransport(provider, { requestTimeoutMs });
    try {
      return await use({ transport, productId: connection.productId, restores });
    } finally {
      transport.dispose();
      provider.dispose();
    }
  } finally {
    lease.release();
  }
}
