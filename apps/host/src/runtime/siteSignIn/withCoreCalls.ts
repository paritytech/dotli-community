// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Runs TrUAPI calls over one leased connection to the page core, and tells their failures apart. */

import { createTransport, type CallErrorValue, type TrUApiTransport, type UnsupportedCallError } from '@parity/truapi';
import { ownCoreConnection } from '../coreConnection.js';
import type { CoreConnection } from '../pageCore.js';

/** A call error whose domain error sits in a versioned envelope, as every TrUAPI method's does. */
export type SiteCallError = CallErrorValue<{ tag: string; value: { tag: string } }> | UnsupportedCallError;

/**
 * Why a call failed: the user rejected it, the wallet does not serve or allow it, or it failed for another reason.
 */
export type SiteCallErrorKind = 'rejected' | 'unsupported' | 'failed';

/** Where the calls get their connection to the page core. */
export type CoreCallsParams = {
  /** Takes a lease on the page's core, whose `connect` opens one connection. Rejects when no lease can be taken. */
  acquire: () => Promise<{
    /** Opens one connection to the core. Rejects with the core's refusal when the connection cannot be made. */
    connect(): Promise<CoreConnection>;
    release(): void;
  }>;
};

type Params = CoreCallsParams & {
  /** How long a request may wait on the phone. */
  requestTimeoutMs: number;
};

/**
 * Runs `use` over one lease and one connection to the core, which it closes and releases after. Resolves with what
 * `use` resolves with, and rejects with what `use`, the lease or the connection rejects with.
 */
export async function withCoreCalls<T>(
  { acquire, requestTimeoutMs }: Params,
  use: (calls: { transport: TrUApiTransport }) => Promise<T>,
): Promise<T> {
  const lease = await acquire();
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

/** Why a call failed. A call the core does not serve at all cannot be made either. */
export function getSiteCallErrorKind(error: SiteCallError): SiteCallErrorKind {
  switch (error.tag) {
    case 'Cancelled':
      return 'rejected';
    case 'Unsupported':
      return 'unsupported';
    case 'Domain':
      return getDomainErrorKind(error.value.value.tag);
    case 'Denied':
    case 'MalformedFrame':
    case 'HostFailure':
      return 'failed';
  }
}

/** Why the wallet refused, by its domain error's tag. A call it does not allow cannot be made either. */
function getDomainErrorKind(tag: string): SiteCallErrorKind {
  if (tag === 'Rejected') {
    return 'rejected';
  }
  return tag === 'NotSupported' || tag === 'PermissionDenied' ? 'unsupported' : 'failed';
}
