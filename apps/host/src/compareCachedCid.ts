// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A redeploy moves the contenthash, so the CID alone tells whether a cached copy is current. */
export type CidComparison = { kind: 'keep' } | { kind: 'evict'; reason: 'cleared' } | { kind: 'newer'; cid: string };

/** Returns what to do with the copy served from `servedCid`, given the name's `freshCid` or null when it is cleared. */
export function compareCachedCid(servedCid: string, freshCid: string | null): CidComparison {
  if (freshCid === null) {
    return { kind: 'evict', reason: 'cleared' };
  }
  return freshCid === servedCid ? { kind: 'keep' } : { kind: 'newer', cid: freshCid };
}
