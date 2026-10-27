// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime config a blocking script sets as a global before any module runs. Each reader checks the build flag
// before it touches the global, so a build without the flag never reads it.

import { readRecord } from './readRecord.js';
import { readStrings } from './readStrings.js';

/**
 * Runtime overrides for the built-in network tables, set by a blocking script so every reader stays synchronous.
 * - Endpoints only. `genesis` and `dotns` are the trust root for name resolution, so an override can only move to
 *   another node of the same chain.
 * - Patches existing networks, so `Network` stays a closed union.
 * - Arrays replace, never concatenate, so a fork's endpoint is never pooled with public ones.
 * The smoldot backends sync from chain specs and ignore `rpcs`. Anything unrecognised throws, because a silently
 * ignored override means running against the public chain.
 */
export type RuntimeNetworkConfig = {
  /** Networks offered in the selector. Overrides `VITE_NETWORKS` when present. */
  readonly enabled?: readonly string[] | undefined;
  /** Per-network endpoint overrides, merged over the built-in entry. Each entry is still unchecked. */
  readonly networks?: Record<string, unknown> | undefined;
  /**
   * Base domain for a host with more than two segments, which would otherwise derive the wrong root. Unchecked, as the
   * page set it.
   */
  readonly baseDomain?: unknown;
};

export const RUNTIME_GLOBAL_KEY = '__DOTLI_NETWORK__';

/**
 * Off unless built for it (the Docker image). The injecting side is gated separately, so neither half alone enables it.
 */
const RUNTIME_CONFIG_ENABLED =
  // Node loaders other than Vite's define no `import.meta.env`, which its type says is always there
  ((import.meta as { env?: Partial<ImportMetaEnv> }).env?.VITE_RUNTIME_NETWORK_CONFIG ?? '') === 'true';

/**
 * The runtime config parsed, or null when the build or the page sets none. Throws when the global is not a non-array
 * object, or holds an `enabled` or `networks` of the wrong shape.
 */
export function readRuntimeNetworkConfig(): RuntimeNetworkConfig | null {
  if (!RUNTIME_CONFIG_ENABLED) {
    return null;
  }
  const raw = readGlobal();
  if (raw === undefined || raw === null) {
    return null;
  }
  return parseRuntimeNetworkConfig(raw);
}

/**
 * A new config with `enabled` and `networks` checked and `baseDomain` as it was. Throws when the value is not a
 * non-array object, a present `enabled` is not an array of strings, or a present `networks` is not a non-array object.
 */
export function parseRuntimeNetworkConfig(value: unknown): RuntimeNetworkConfig {
  const path = `globalThis.${RUNTIME_GLOBAL_KEY}`;
  const record = readRecord(value, path);
  const { enabled, networks, baseDomain } = record;
  return {
    enabled: enabled === undefined ? undefined : readStrings(enabled, `${path}.enabled`),
    networks: networks === undefined ? undefined : readRecord(networks, `${path}.networks`),
    baseDomain,
  };
}

/** The runtime global as the page set it, unchecked, or undefined when the build reads none. Never throws. */
export function readRuntimeGlobal(): unknown {
  if (!RUNTIME_CONFIG_ENABLED) {
    return undefined;
  }
  return readGlobal();
}

function readGlobal(): unknown {
  return Reflect.get(globalThis, RUNTIME_GLOBAL_KEY);
}
