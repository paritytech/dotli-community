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
  parseExecutableManifest,
  parseRootManifest,
  type ExecutableKind,
  type ExecutableManifest,
  type RootManifest,
  type ValidationResult,
} from './manifest-types.js';

export const ROOT_MANIFEST_KEY = 'manifest';
export const EXECUTABLE_MANIFEST_KEY = 'executable';

/**
 * Discriminated result so callers can tell "no manifest set" apart from
 * "manifest exists but malformed". Same shape as `decodeIpfsContenthashResult`
 *  used for legacy contenthash reads.
 *
 * Every result read from a record carries its text as `raw`, so a caller can
 * keep it and validate it again later with `toRootManifestResult` /
 * `toExecutableManifestResult`. `unsupported` is about the network (it has no
 * text records), `unsupported-version` about the manifest (a `$v` other than 1).
 */
export type ManifestResult<T> =
  | { kind: 'ok'; value: T; raw: string }
  | { kind: 'empty' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unsupported-version'; version: unknown; raw: string }
  | { kind: 'invalid'; errors: string[]; raw: string };

/** What a manifest record's text can come to: everything but the network-level `unsupported`. */
export type ManifestRecordResult<T> = Exclude<ManifestResult<T>, { kind: 'unsupported' }>;

function toManifestResult<T>(
  raw: string | null,
  parse: (json: string) => ValidationResult<T>,
): ManifestRecordResult<T> {
  if (raw === null || raw.length === 0) {
    return { kind: 'empty' };
  }
  const parsed = parse(raw);
  if (parsed.ok) {
    return { kind: 'ok', value: parsed.value, raw };
  }
  if ('unsupportedVersion' in parsed) {
    return { kind: 'unsupported-version', version: parsed.unsupportedVersion, raw };
  }
  return { kind: 'invalid', errors: parsed.errors, raw };
}

/** Validate a root manifest record's text (`null` or empty: no record). */
export function toRootManifestResult(raw: string | null): ManifestRecordResult<RootManifest> {
  return toManifestResult(raw, parseRootManifest);
}

/**
 * Validate the text of the executable manifest read from `<kind>.<label>`.
 * A manifest whose `kind` disagrees with that subname is invalid, so one
 * tagged `kind: "worker"` cannot pose as the app.
 */
export function toExecutableManifestResult(
  raw: string | null,
  kind: ExecutableKind,
): ManifestRecordResult<ExecutableManifest> {
  const result = toManifestResult(raw, parseExecutableManifest);
  if (result.kind === 'ok' && result.value.kind !== kind) {
    return {
      kind: 'invalid',
      errors: [`executable manifest kind '${result.value.kind}' does not match its subname '${kind}'`],
      raw: result.raw,
    };
  }
  return result;
}

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
  log.warn(
    `[dot.li manifest] reading text(${node.slice(0, 10)}…, "${key}") on ${dotns.DOTNS_CONTENT_RESOLVER.slice(0, 10)}… slot=${String(textRecordsSlot)} kind=${metricKind}`,
  );
  let raw: string | null;
  try {
    raw = await readNestedMappingString(api, dotns.DOTNS_CONTENT_RESOLVER, node, key, textRecordsSlot);
  } catch (err) {
    m.distribution(S.RESOLVE_MANIFEST_READ, performance.now() - t0, 'millisecond', {
      kind: metricKind,
      outcome: 'error',
    });
    log.warn(
      `[dot.li resolve] manifest read failed kind=${metricKind} key=${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  if (raw === null || raw.length === 0) {
    log.warn(
      `[dot.li manifest] text(${node.slice(0, 10)}…, "${key}") -> empty (${(performance.now() - t0).toFixed(0)}ms)`,
    );
    m.distribution(S.RESOLVE_MANIFEST_READ, performance.now() - t0, 'millisecond', {
      kind: metricKind,
      outcome: 'empty',
    });
    return { kind: 'empty' };
  }
  log.warn(
    `[dot.li manifest] text(${node.slice(0, 10)}…, "${key}") -> ${String(raw.length)} bytes (${(performance.now() - t0).toFixed(0)}ms): ${raw.slice(0, 200)}${raw.length > 200 ? '…' : ''}`,
  );
  const result = judge(raw);
  m.distribution(S.RESOLVE_MANIFEST_READ, performance.now() - t0, 'millisecond', {
    kind: metricKind,
    outcome: result.kind,
  });
  return result;
}

export type { ExecutableKind, ExecutableManifest, RootManifest } from './manifest-types.js';
