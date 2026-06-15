// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Resolver error types.
//
// One class per failure mode. Each class extends `ResolverError` so a
// caller can catch on the base type when it does not care about the
// specific reason. The `name` field is a string literal, so a switch on
// `error.name` narrows the type with no extra runtime cost.
//
// Use `instanceof` for branching. Use `error.cause` when wrapping a
// lower-level failure so the original stack survives.

/**
 * Discriminator for every error class in this module.
 *
 * Keep this union in sync with the subclasses below. Dashboards and Sentry
 * tags read this string verbatim, so renames are a breaking change for
 * downstream filters.
 */
export type ResolverErrorName =
  | "PartialStorageReadError"
  | "UnsupportedContenthashCodecError"
  | "ContenthashDecodeError"
  | "NetworkSyncTimeoutError";

/**
 * Base type for every error the resolver package throws.
 *
 * Catch on this to handle any resolver failure without listing every
 * subclass. Subclasses pin `name` to a `ResolverErrorName` literal, which
 * lets a switch on `error.name` discriminate without `instanceof`.
 */
export abstract class ResolverError extends Error {
  abstract override readonly name: ResolverErrorName;
}

/**
 * Reading a multi-slot contract value aborted partway through.
 *
 * Treated as a transient RPC inconsistency. The caller should surface the
 * failure rather than silently zero-pad the gap, because a zero-padded
 * result decodes as "name not found" and masks the actual fault.
 */
export class PartialStorageReadError extends ResolverError {
  override readonly name = "PartialStorageReadError" as const;
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
    const innerKeyPart =
      context.innerKey !== undefined ? `, key=${context.innerKey}` : "";
    super(
      `Partial storage read at slot ${String(slotIndex)}/${String(slotsExpected)} for ${context.mappingKind} (contract=${contractAddress}${innerKeyPart})`,
    );
    this.contractAddress = contractAddress;
    this.slotIndex = slotIndex;
    this.slotsExpected = slotsExpected;
    this.context = context;
  }
}

/**
 * The contenthash is set but uses a codec other than IPFS.
 *
 * dotli only renders IPFS-codec contenthashes. Other codecs (Swarm, Arweave)
 * are valid CIDs but cannot be fetched by the protocol layer, so the host
 * surfaces a dedicated error instead of conflating with "no record set".
 */
export class UnsupportedContenthashCodecError extends ResolverError {
  override readonly name = "UnsupportedContenthashCodecError" as const;
  readonly domain: string;
  readonly codec: string | null;

  constructor(domain: string, codec: string | null) {
    super(
      `Domain "${domain}" has a non-IPFS contenthash (codec=${codec ?? "unknown"})`,
    );
    this.domain = domain;
    this.codec = codec;
  }
}

/**
 * The contenthash bytes failed to decode to a valid CID.
 *
 * Distinguishes a malformed record from "no record set". The original
 * decoder failure is preserved via `cause` so the stack trace survives.
 */
export class ContenthashDecodeError extends ResolverError {
  override readonly name = "ContenthashDecodeError" as const;
  readonly domain: string;

  constructor(domain: string, cause: unknown) {
    super(
      `Failed to decode contenthash for "${domain}": ${cause instanceof Error ? cause.message : String(cause)}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.domain = domain;
  }
}

/**
 * Reaching the first finalized block on the upstream chain timed out.
 *
 * Smoldot started and added the relay chain, but the peer set never produced
 * a finalized parachain block in time. Surfaced as a fatal so the host can
 * offer the gateway escape rather than sit on the loading screen.
 */
export class NetworkSyncTimeoutError extends ResolverError {
  override readonly name = "NetworkSyncTimeoutError" as const;
  readonly chain: string;
  readonly timeoutMs: number;

  constructor(chain: string, timeoutMs: number) {
    super(
      `Sync to ${chain} timed out after ${(timeoutMs / 1000).toFixed(0)}s. Unable to reach peers.`,
    );
    this.chain = chain;
    this.timeoutMs = timeoutMs;
  }
}
