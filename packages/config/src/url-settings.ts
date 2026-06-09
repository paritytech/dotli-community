// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Two-way sync between the URL and host shell settings.
//
// Each `*.dot.li` is its own browser origin with its own localStorage, so
// a fresh subdomain otherwise resets every settings axis. URL params let
// a shared link seed those settings.
//
// Resolution order per axis is URL, then localStorage, then default. After
// resolution the host writes the chosen values back to both localStorage
// and the URL (default-valued axes are stripped), so a clean
// `acme.dot.li` URL always means "every axis at default" and a recipient
// of a shared link sees the sender's exact configuration.
//
// Param names and default values are intentionally inlined here rather
// than imported from `mode.ts`, `network.ts`, or `host-sandbox-contract.ts`.
// They are part of the public URL contract surface and changing them
// belongs in this file too.

import { defaultNetwork, isValidNetwork, type Network } from "./network";
import {
  defaultBackend,
  isSharedWorkerAvailable,
  type Backend,
  type CacheSettings,
} from "./mode";

const URL_PARAM_NAMES = {
  network: "network",
  chainBackend: "chainBackend",
  skipArchiveCache: "skipArchiveCache",
  skipCidCache: "skipCidCache",
  skipWorkerCache: "skipWorkerCache",
} as const;

const URL_DEFAULT_CACHE: CacheSettings = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
  "smoldot-direct",
  "smoldot-shared-worker",
  "rpc-gateway",
]);

const VALID_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["0", "1"]);

/** Per-axis URL parse: `null` for absent or invalid, so callers can `?? fallback`. */
export interface ParsedUrlSettings {
  network: Network | null;
  chainBackend: Backend | null;
  skipArchiveCache: boolean | null;
  skipCidCache: boolean | null;
  skipWorkerCache: boolean | null;
}

/** Effective settings used as the input for URL canonicalisation. */
export interface EffectiveSettings {
  network: Network;
  chainBackend: Backend;
  cache: CacheSettings;
}

function parseBoolean(raw: string | null): boolean | null {
  if (raw === null || !VALID_BOOLEAN_FLAGS.has(raw)) {
    return null;
  }
  return raw === "1";
}

/** Extract per-axis settings values from a URLSearchParams. */
export function parseSettingsFromSearch(
  search: URLSearchParams,
): ParsedUrlSettings {
  const rawNetwork = search.get(URL_PARAM_NAMES.network);
  const rawBackend = search.get(URL_PARAM_NAMES.chainBackend);
  const backend =
    rawBackend !== null && VALID_BACKENDS.has(rawBackend)
      ? (rawBackend as Backend)
      : null;
  return {
    network:
      rawNetwork !== null && isValidNetwork(rawNetwork) ? rawNetwork : null,
    chainBackend:
      backend === "smoldot-shared-worker" && !isSharedWorkerAvailable()
        ? null
        : backend,
    skipArchiveCache: parseBoolean(
      search.get(URL_PARAM_NAMES.skipArchiveCache),
    ),
    skipCidCache: parseBoolean(search.get(URL_PARAM_NAMES.skipCidCache)),
    skipWorkerCache: parseBoolean(search.get(URL_PARAM_NAMES.skipWorkerCache)),
  };
}

/** Canonicalize `search` in place to mirror `settings`, dropping default-valued axes. Returns true if mutated. */
export function writeSettingsToSearch(
  settings: EffectiveSettings,
  search: URLSearchParams,
): boolean {
  const before = search.toString();
  applyAxis(
    search,
    URL_PARAM_NAMES.network,
    settings.network === defaultNetwork() ? null : settings.network,
  );
  applyAxis(
    search,
    URL_PARAM_NAMES.chainBackend,
    settings.chainBackend === defaultBackend() ? null : settings.chainBackend,
  );
  applyBooleanAxis(
    search,
    URL_PARAM_NAMES.skipArchiveCache,
    settings.cache.skipArchiveCache,
    URL_DEFAULT_CACHE.skipArchiveCache,
  );
  applyBooleanAxis(
    search,
    URL_PARAM_NAMES.skipCidCache,
    settings.cache.skipCidCache,
    URL_DEFAULT_CACHE.skipCidCache,
  );
  applyBooleanAxis(
    search,
    URL_PARAM_NAMES.skipWorkerCache,
    settings.cache.skipWorkerCache,
    URL_DEFAULT_CACHE.skipWorkerCache,
  );
  return search.toString() !== before;
}

function applyAxis(
  search: URLSearchParams,
  key: string,
  desired: string | null,
): void {
  if (desired === null) {
    search.delete(key);
  } else {
    search.set(key, desired);
  }
}

function applyBooleanAxis(
  search: URLSearchParams,
  key: string,
  current: boolean,
  defaultValue: boolean,
): void {
  applyAxis(search, key, current === defaultValue ? null : current ? "1" : "0");
}
