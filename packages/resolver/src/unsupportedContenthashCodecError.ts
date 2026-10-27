// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ResolverError } from './resolverError.js';

/** The contenthash is set but not IPFS, which dotli cannot fetch. */
export class UnsupportedContenthashCodecError extends ResolverError {
  override readonly name = 'UnsupportedContenthashCodecError' as const;
  readonly domain: string;
  readonly codec: string | null;

  constructor(domain: string, codec: string | null) {
    super(`Domain "${domain}" has a non-IPFS contenthash (codec=${codec ?? 'unknown'})`);
    this.domain = domain;
    this.codec = codec;
  }
}
