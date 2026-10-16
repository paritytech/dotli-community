// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Dashboards and Sentry filters read these verbatim, so a rename breaks them. */
export type ResolverErrorName =
  'PartialStorageReadError' | 'UnsupportedContenthashCodecError' | 'ContenthashDecodeError' | 'NetworkSyncTimeoutError';

export abstract class ResolverError extends Error {
  abstract override readonly name: ResolverErrorName;
}

/** A multi-slot read stopped partway. Zero-padding instead would decode as "name not found". */
export class PartialStorageReadError extends ResolverError {
  override readonly name = 'PartialStorageReadError' as const;
  readonly contractAddress: string;
  readonly slotIndex: number;
  readonly slotsExpected: number;
  readonly context: { mappingKind: string; innerKey?: string };

  constructor(
    contractAddress: string,
    slotIndex: number,
    slotsExpected: number,
    context: { mappingKind: string; innerKey?: string },
  ) {
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

export class ContenthashDecodeError extends ResolverError {
  override readonly name = 'ContenthashDecodeError' as const;
  readonly domain: string;

  constructor(domain: string, cause: unknown) {
    super(
      `Failed to decode contenthash for "${domain}": ${cause instanceof Error ? cause.message : String(cause)}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.domain = domain;
  }
}

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
