// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorMessage } from '@dotli/shared';
import { ResolverError } from './resolverError.js';

/** The contenthash claims IPFS but does not decode to a CID. */
export class ContenthashDecodeError extends ResolverError {
  override readonly name = 'ContenthashDecodeError' as const;
  readonly domain: string;

  constructor(domain: string, cause: unknown) {
    super(
      `Failed to decode contenthash for "${domain}": ${getErrorMessage(cause)}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.domain = domain;
  }
}
