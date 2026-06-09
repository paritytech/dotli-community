// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product manifest reader.
//
// Reads text records off `DOTNS_CONTENT_RESOLVER`. The root manifest sits
// at `<id>.dot` under the `manifest` key. Each executable manifest sits at
// `<kind>.<id>.dot` under the `executable` key. The JSON is parsed and
// validated against `./manifest-types.ts`. These calls are read-only and
// never sign or write.
//
// The entry points take an `Api` rather than reaching for the
// resolver's cached client, so both the smoldot and gateway paths can
// share the same code.

import { log } from "@dotli/shared/log";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import type { DotnsContracts } from "@dotli/config/network";
import { namehash } from "./abi";
import { readNestedMappingString } from "./access-raw-storage";
import type { Api } from "./api";
import {
  parseExecutableManifest,
  parseRootManifest,
  type ExecutableKind,
  type ExecutableManifest,
  type RootManifest,
} from "./manifest-types";

export const ROOT_MANIFEST_KEY = "manifest";
export const EXECUTABLE_MANIFEST_KEY = "executable";

/**
 * Discriminated result so callers can tell "no manifest set" apart from
 * "manifest exists but malformed". Same shape as `decodeIpfsContenthashResult`
 * uses for legacy contenthash reads.
 */
export type ManifestResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "empty" }
  | { kind: "unsupported"; reason: string }
  | { kind: "invalid"; errors: string[] };

/**
 * Read the root manifest at `<label>.dot` text-record key `"manifest"`.
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
  const slot = dotns.storageSlots.TEXT_RECORDS;
  if (slot === undefined) {
    return { kind: "unsupported", reason: "TEXT_RECORDS slot not configured" };
  }
  return readManifestText(
    api,
    dotns,
    namehash(`${label}.dot`),
    ROOT_MANIFEST_KEY,
    slot,
    "root",
    parseRootManifest,
  );
}

/**
 * Read the executable manifest at `<kind>.<label>.dot` text-record key
 * `"executable"`.
 *
 * Each executable lives on its own well-known subname. The reader rejects
 * any manifest whose `kind` field disagrees with the subname it was read
 * from, so a manifest tagged `kind: "worker"` cannot pose as the app.
 */
export async function readExecutableManifest(
  api: Api,
  dotns: DotnsContracts,
  label: string,
  kind: ExecutableKind,
): Promise<ManifestResult<ExecutableManifest>> {
  const slot = dotns.storageSlots.TEXT_RECORDS;
  if (slot === undefined) {
    return { kind: "unsupported", reason: "TEXT_RECORDS slot not configured" };
  }
  const result = await readManifestText(
    api,
    dotns,
    namehash(`${kind}.${label}.dot`),
    EXECUTABLE_MANIFEST_KEY,
    slot,
    kind,
    parseExecutableManifest,
  );
  if (result.kind === "ok" && result.value.kind !== kind) {
    return {
      kind: "invalid",
      errors: [
        `executable manifest kind '${result.value.kind}' does not match subname '${kind}.${label}.dot'`,
      ],
    };
  }
  return result;
}

async function readManifestText<T>(
  api: Api,
  dotns: DotnsContracts,
  node: `0x${string}`,
  key: string,
  textRecordsSlot: number,
  metricKind: string,
  parse: (
    json: string,
  ) => { ok: true; value: T } | { ok: false; errors: string[] },
): Promise<ManifestResult<T>> {
  const t0 = performance.now();
  log.warn(
    `[dot.li manifest] reading text(${node.slice(0, 10)}…, "${key}") on ${dotns.DOTNS_CONTENT_RESOLVER.slice(0, 10)}… slot=${String(textRecordsSlot)} kind=${metricKind}`,
  );
  let raw: string | null;
  try {
    raw = await readNestedMappingString(
      api,
      dotns.DOTNS_CONTENT_RESOLVER,
      node,
      key,
      textRecordsSlot,
    );
  } catch (err) {
    m.distribution(
      S.RESOLVE_MANIFEST_READ,
      performance.now() - t0,
      "millisecond",
      { kind: metricKind, outcome: "error" },
    );
    log.warn(
      `[dot.li resolve] manifest read failed kind=${metricKind} key=${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  if (raw === null || raw.length === 0) {
    log.warn(
      `[dot.li manifest] text(${node.slice(0, 10)}…, "${key}") -> empty (${(performance.now() - t0).toFixed(0)}ms)`,
    );
    m.distribution(
      S.RESOLVE_MANIFEST_READ,
      performance.now() - t0,
      "millisecond",
      { kind: metricKind, outcome: "empty" },
    );
    return { kind: "empty" };
  }
  log.warn(
    `[dot.li manifest] text(${node.slice(0, 10)}…, "${key}") -> ${String(raw.length)} bytes (${(performance.now() - t0).toFixed(0)}ms): ${raw.slice(0, 200)}${raw.length > 200 ? "…" : ""}`,
  );
  const parsed = parse(raw);
  m.distribution(
    S.RESOLVE_MANIFEST_READ,
    performance.now() - t0,
    "millisecond",
    { kind: metricKind, outcome: parsed.ok ? "ok" : "invalid" },
  );
  return parsed.ok
    ? { kind: "ok", value: parsed.value }
    : { kind: "invalid", errors: parsed.errors };
}

export type {
  ExecutableKind,
  ExecutableManifest,
  RootManifest,
} from "./manifest-types";
