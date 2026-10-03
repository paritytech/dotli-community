// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product manifest reader.
//
// Reads text records off `DOTNS_CONTENT_RESOLVER`. The root manifest sits
// at `<id>.<tld>` under the `manifest` key. Each executable manifest sits at
// `<kind>.<id>.<tld>` under the `executable` key. The JSON is parsed and
// validated against `./manifest-types.ts`. These calls are read-only and
// never signed or written.
//
// The entry points take an `Api` rather than reaching for the
// resolver's cached client, so both the smoldot and gateway paths can
// share the same code.

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

/**
 * Read the root manifest at `<label>.<tld>` text-record key `"manifest"`.
 *
 * Returns `{ kind: "unsupported" }` when the active network's content
 * resolver has no `TEXT_RECORDS` slot configured. The caller treats this
 * as "manifest layer not available on this network" rather than as a
 * missing record, so the loading flow falls back to the legacy contenthash.
 */
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

/**
 * Read the executable manifest at `<kind>.<label>.<tld>` text-record key
 * `"executable"`. Each executable lives on its own well-known subname; see
 * `toExecutableManifestResult` for how the record is judged.
 */
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
  // The record text is published by the name's owner and can be large, so the
  // trail carries its size and verdict rather than the text itself.
  log.event('Manifest read', {
    flow: 'resolve',
    kind: metricKind,
    bytes: raw?.length ?? 0,
    outcome: result.kind,
    ms: Math.round(ms),
  });
  return result;
}

export type {
  ExecutableKind,
  ExecutableManifest,
  ManifestRecordResult,
  ManifestResult,
  RootManifest,
} from './manifest-types.js';
export { toExecutableManifestResult, toRootManifestResult } from './manifest-types.js';
