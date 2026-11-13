// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';
import { createReporter, m } from '@dotli/metrics';
import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import type { ManifestRecordResult, ManifestResult } from './manifestTypes.js';
import { readPinnedBytes } from './readPinnedBytes.js';
import { computeNestedStringMappingSlot } from './storageSlots.js';

const report = createReporter({ flow: 'resolve' });

/**
 * Read and validate one manifest text record. Tag `kind` (`root, app, widget, worker`) and `outcome`
 * (`ok, empty, invalid, error`) so "no manifest yet" is told apart from "malformed".
 */
const RESOLVE_MANIFEST_READ = 'resolve.manifest_read';

type Params<T> = {
  api: Api;
  dotns: DotnsContracts;
  node: `0x${string}`;
  key: string;
  /** The `kind` the read's metric and breadcrumb carry. */
  metricKind: string;
  judge: (raw: string | null) => ManifestRecordResult<T>;
};

/**
 * Reads a manifest text record and judges it. `unsupported` when the network has no text records slot, with nothing
 * recorded. Rejects with the storage read's error, after recording it.
 */
export async function readManifestText<T>({
  api,
  dotns,
  node,
  key,
  metricKind,
  judge,
}: Params<T>): Promise<ManifestResult<T>> {
  const textRecordsSlot = dotns.STORAGE_SLOTS.TEXT_RECORDS;
  if (textRecordsSlot === undefined) {
    return { kind: 'unsupported', reason: 'TEXT_RECORDS slot not configured' };
  }
  const start = performance.now();
  let raw: string | null;
  try {
    const bytes = await readPinnedBytes({
      api,
      contractAddress: dotns.DOTNS_CONTENT_RESOLVER,
      baseSlotKey: computeNestedStringMappingSlot({ outerKey: node, innerKey: key, outerSlot: textRecordsSlot }),
      context: { mappingKind: 'nested string mapping', innerKey: key },
    });
    raw = bytes === null ? null : new TextDecoder().decode(bytes);
  } catch (error) {
    const ms = performance.now() - start;
    m.distribution(RESOLVE_MANIFEST_READ, ms, {
      unit: 'millisecond',
      attributes: { kind: metricKind, outcome: 'error' },
    });
    log.warn(`[dot.li manifest] ${metricKind} manifest read failed (${String(Math.round(ms))}ms)`, error);
    throw error;
  }
  const result = judge(raw);
  const ms = performance.now() - start;
  m.distribution(RESOLVE_MANIFEST_READ, ms, {
    unit: 'millisecond',
    attributes: { kind: metricKind, outcome: result.kind },
  });
  // The owner controls the text and it can be large, so only its size goes in the trail.
  report.log.event('Manifest read', {
    kind: metricKind,
    bytes: raw?.length ?? 0,
    outcome: result.kind,
    ms: Math.round(ms),
  });
  return result;
}
