// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ResolverError } from './resolverError.js';

type Params = {
  contractAddress: string;
  slotIndex: number;
  slotsExpected: number;
  context: { mappingKind: string; innerKey?: string };
};

/** A multi-slot read stopped partway. Zero-padding instead would decode as "name not found". */
export class PartialStorageReadError extends ResolverError {
  override readonly name = 'PartialStorageReadError' as const;
  readonly contractAddress: string;
  readonly slotIndex: number;
  readonly slotsExpected: number;
  readonly context: { mappingKind: string; innerKey?: string };

  constructor({ contractAddress, slotIndex, slotsExpected, context }: Params) {
    const innerKeyPart = context.innerKey !== undefined ? `, key=${context.innerKey}` : '';
    super(
      `Partial storage read at slot ${String(slotIndex)}/${String(slotsExpected)} for ${context.mappingKind} (contract=${contractAddress}${innerKeyPart})`,
    );
    this.contractAddress = contractAddress;
    this.slotIndex = slotIndex;
    this.slotsExpected = slotsExpected;
    this.context = context;
  }
}
