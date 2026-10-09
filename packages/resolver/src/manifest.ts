// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Takes an `Api` rather than the resolver's cached client, so the smoldot and gateway paths share it.

import { log } from '@dotli/shared';
import { m, spans as S } from '@dotli/metrics';
import type { DotnsContracts } from '@dotli/config';
import { namehash } from './abi.js';
import { readNestedMappingString } from './access-raw-storage.js';
import type { Api } from './api.js';
import {
  toExecutableManifestResult,
  toRootManifestResult,
  type ExecutableKind,
  type ExecutableManifest,
  type ManifestRecordResult,
  type ManifestResult,
  type RootManifest,
} from './manifest-types.js';

export const ROOT_MANIFEST_KEY = 'manifest';
export const EXECUTABLE_MANIFEST_KEY = 'executable';

/** `unsupported` when the network has no text records, so loading falls back to the contenthash alone. */
export async function readRootManifest(
  api: Api,
  dotns: DotnsContracts,
  label: string,
): Promise<ManifestResult<RootManifest>> {
  const slot = dotns.STORAGE_SLOTS.TEXT_RECORDS;
  if (slot === undefined) {
    return { kind: 'unsupported', reason: 'TEXT_RECORDS slot not configured' };
  }
  return readManifestText(
    api,
    dotns,
    namehash(`${label}.${dotns.TLD}`),
    ROOT_MANIFEST_KEY,
    slot,
    'root',
    toRootManifestResult,
  );
}

export async function readExecutableManifest(
  api: Api,
  dotns: DotnsContracts,
  label: string,
  kind: ExecutableKind,
): Promise<ManifestResult<ExecutableManifest>> {
  const slot = dotns.STORAGE_SLOTS.TEXT_RECORDS;
  if (slot === undefined) {
    return { kind: 'unsupported', reason: 'TEXT_RECORDS slot not configured' };
  }
  return readManifestText(
    api,
    dotns,
    namehash(`${kind}.${label}.${dotns.TLD}`),
    EXECUTABLE_MANIFEST_KEY,
    slot,
    kind,
    raw => toExecutableManifestResult(raw, kind),
  );
}

async function readManifestText<T>(
  api: Api,
  dotns: DotnsContracts,
  node: `0x${string}`,
  key: string,
  textRecordsSlot: number,
  metricKind: string,
  judge: (raw: string | null) => ManifestRecordResult<T>,
): Promise<ManifestResult<T>> {
  const t0 = performance.now();
  let raw: string | null;
  try {
    raw = await readNestedMappingString(api, dotns.DOTNS_CONTENT_RESOLVER, node, key, textRecordsSlot);
  } catch (err) {
    const ms = performance.now() - t0;
    m.distribution(S.RESOLVE_MANIFEST_READ, ms, 'millisecond', {
      kind: metricKind,
      outcome: 'error',
    });
    log.warn(`[dot.li manifest] ${metricKind} manifest read failed (${String(Math.round(ms))}ms)`, err);
    throw err;
  }
  const result = judge(raw);
  const ms = performance.now() - t0;
  m.distribution(S.RESOLVE_MANIFEST_READ, ms, 'millisecond', {
    kind: metricKind,
    outcome: result.kind,
  });
  // The owner controls the text and it can be large, so only its size goes in the trail.
  log.event('Manifest read', {
    flow: 'resolve',
    kind: metricKind,
    bytes: raw?.length ?? 0,
    outcome: result.kind,
    ms: Math.round(ms),
  });
  return result;
}

export type { ExecutableKind, ExecutableManifest, ManifestResult, RootManifest } from './manifest-types.js';
