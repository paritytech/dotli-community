// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads one block for the relay, from the cache when it holds a copy that checks out and from the network otherwise,
// and checks every block against its CID on the way.

import { createReporter, defineCount } from '@dotli/metrics';
import { setErrorName } from '@dotli/shared';

const report = createReporter({ flow: 'content' });

/**
 * A bitswap relay step that failed. Tag `outcome` (`error`), `reason` (the error name) and `step` (`verify, cache_read,
 * cache_delete, cache_write`).
 */
const contentBlockRelayMetric = defineCount<'error'>('content.block_relay');

export type BlockOrigin = 'cache' | 'network';

export type BlockCache = {
  /**
   * Must return a fresh copy, since the relay transfers the buffer to the sandbox and detaches it. Resolves null on a
   * miss and rejects when the store cannot be read.
   */
  get: (cid: string) => Promise<Uint8Array | null>;
  /** Stores the bytes under the CID. Rejects when the store cannot be written. */
  put: (cid: string, bytes: Uint8Array) => Promise<void>;
  /** Removes the CID's entry, and resolves when there is none. Rejects when the store cannot be written. */
  delete: (cid: string) => Promise<void>;
};

/** Where a block can come from, and the check every block passes. */
export type BlockSources = {
  /** Fetches one block over the network. The signal aborts when the frame that asked goes away. */
  blocks: (cid: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Null when the settings skip the archive cache. */
  cache: BlockCache | null;
  /**
   * Whether the bytes hash to the CID. This relay is the one check of every block on its path. A rejection leaves the
   * answer unknown, so the block is not served or written, and a cached copy is kept for a verifier that loads later.
   * The verifier reports why it could not run.
   */
  verify: (cid: string, bytes: Uint8Array) => Promise<boolean>;
};

export type ServedBlock = {
  bytes: Uint8Array;
  from: BlockOrigin;
};

/** `unknown` when the verifier could not run, which says nothing about the bytes. */
type Verdict = { kind: 'match' } | { kind: 'mismatch' } | { kind: 'unknown'; cause: unknown };

type RelayStep = 'verify' | 'cache_read' | 'cache_delete' | 'cache_write';

type ReportRelayFailureParams = {
  /** The relay step that failed. */
  step: RelayStep;
  /** What the step threw. */
  error: unknown;
  /** The block the step handled, when there was one. */
  cid?: string;
  /** The metric reason. The error's name when not given. */
  reason?: string;
};

/**
 * Spelled as `CONTENT_ERRORS.VERIFICATION`, which bitswap may not import. The sandbox branches on this name.
 */
const VERIFICATION_ERROR = 'ContentVerificationError';

/**
 * The block `cid` names, checked against it. Rejects with a `ContentVerificationError` when the network's bytes do
 * not hash to `cid` or cannot be checked, and with the network's error when the fetch fails.
 */
export async function serveBlock(cid: string, signal: AbortSignal, sources: BlockSources): Promise<ServedBlock> {
  const { blocks, cache } = sources;
  if (cache !== null) {
    const cached = await readCached(cid, cache, sources);
    if (cached !== null) {
      return { bytes: cached, from: 'cache' };
    }
  }
  const bytes = await blocks(cid, signal);
  // The sandbox re-hashes only the root block, so this is the check for every other block a peer sends.
  const verdict = await check(cid, bytes, sources);
  if (verdict.kind === 'mismatch') {
    const error = setErrorName(new Error(`Block ${cid} does not hash to its CID`), VERIFICATION_ERROR);
    reportRelayFailure({ step: 'verify', error, cid, reason: 'mismatch' });
    throw error;
  }
  // Fail closed. The verifier already reported why it could not run, so this refusal is not reported again.
  if (verdict.kind === 'unknown') {
    throw setErrorName(
      new Error(`Block ${cid} could not be checked against its CID`, { cause: verdict.cause }),
      VERIFICATION_ERROR,
    );
  }
  if (cache !== null) {
    // The reply detaches `bytes.buffer` before the IndexedDB write clones it.
    void cache.put(cid, bytes.slice()).catch((error: unknown) => {
      reportRelayFailure({ step: 'cache_write', error });
    });
  }
  return { bytes, from: 'network' };
}

async function readCached(
  cid: string,
  cache: BlockCache,
  { verify }: Pick<BlockSources, 'verify'>,
): Promise<Uint8Array | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await cache.get(cid);
  } catch (error) {
    reportRelayFailure({ step: 'cache_read', error });
    return null;
  }
  if (bytes === null) {
    return null;
  }
  const verdict = await check(cid, bytes, { verify });
  if (verdict.kind === 'match') {
    return bytes;
  }
  // Unverified, so this read goes to the network, and the copy waits for a verifier that loads.
  if (verdict.kind === 'unknown') {
    return null;
  }
  // Corrupted on disk. Dropped so the network copy takes its place.
  void cache.delete(cid).catch((error: unknown) => {
    reportRelayFailure({ step: 'cache_delete', error });
  });
  return null;
}

async function check(cid: string, bytes: Uint8Array, { verify }: Pick<BlockSources, 'verify'>): Promise<Verdict> {
  try {
    return (await verify(cid, bytes)) ? { kind: 'match' } : { kind: 'mismatch' };
  } catch (error) {
    // The verifier reported why it could not run, so each block it leaves unchecked is expected and counted.
    report.expected(error, {
      step: 'relay_verify',
      metric: contentBlockRelayMetric,
      attributes: { step: 'verify' },
    });
    return { kind: 'unknown', cause: error };
  }
}

/** A relay step that failed and was worked around, reported so the workaround does not hide it. */
function reportRelayFailure({ step, error, cid, reason }: ReportRelayFailureParams): void {
  report.defect(error, {
    step: `relay_${step}`,
    ...(cid === undefined ? {} : { tags: { cid } }),
    metric: contentBlockRelayMetric,
    attributes: { step },
    message: `[dot.li bitswap-relay] ${step} failed${cid === undefined ? '' : ` for ${cid}`}:`,
    ...(reason === undefined ? {} : { reason }),
  });
}
