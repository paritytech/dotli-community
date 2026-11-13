// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PartialStorageReadError } from './partialStorageReadError.js';
import { ResolverError } from './resolverError.js';

type Params = {
  contractAddress: string;
  length: number;
  context: PartialStorageReadError['context'];
};

/** A `bytes` slot claims a length whose data slots no read can hold. */
export class CorruptBytesSlotError extends ResolverError {
  override readonly name = 'CorruptBytesSlotError' as const;
  readonly contractAddress: string;
  readonly length: number;
  readonly context: PartialStorageReadError['context'];

  constructor({ contractAddress, length, context }: Params) {
    const innerKeyPart = context.innerKey !== undefined ? `, key=${context.innerKey}` : '';
    super(
      `Corrupt bytes slot claims length ${String(length)} for ${context.mappingKind} (contract=${contractAddress}${innerKeyPart})`,
    );
    this.contractAddress = contractAddress;
    this.length = length;
    this.context = context;
  }
}
