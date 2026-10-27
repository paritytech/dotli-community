// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each subdomain is its own origin with its own localStorage, so URL params let a shared link carry settings.
// Default-valued axes are stripped, so a clean URL means every axis at default.
// Param names are inlined because they are the public URL contract.

import { getDefaultBackend, parseBackend, type Backend } from './backend.js';
import { DEFAULT_CACHE } from './cacheSettings.js';
import { getDefaultNetwork } from './getEnabledNetworks.js';
import { isValidNetwork, type Network } from './networkNames.js';
import type { Settings } from './resolveSettings.js';

/** Per-axis URL parse: `null` for absent or invalid, so callers can `?? fallback`. */
export type ParsedUrlSettings = {
  network: Network | null;
  backend: Backend | null;
  skipArchiveCache: boolean | null;
  skipCidCache: boolean | null;
  skipWorkerCache: boolean | null;
};

type AxisParams = {
  search: URLSearchParams;
  key: string;
  /** The value to write, or null to drop the axis. */
  desired: string | null;
};

type BooleanAxisParams = {
  search: URLSearchParams;
  key: string;
  current: boolean;
  defaultValue: boolean;
};

const URL_PARAM_NAMES = {
  network: 'network',
  backend: 'chainBackend',
  skipArchiveCache: 'skipArchiveCache',
  skipCidCache: 'skipCidCache',
  skipWorkerCache: 'skipWorkerCache',
} as const;

const VALID_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['0', '1']);

/** The link's settings as written. `resolveSettings` applies what this browser can run. */
export function parseSettingsFromSearch(search: URLSearchParams): ParsedUrlSettings {
  const rawNetwork = search.get(URL_PARAM_NAMES.network);
  return {
    network: rawNetwork !== null && isValidNetwork(rawNetwork) ? rawNetwork : null,
    backend: parseBackend(search.get(URL_PARAM_NAMES.backend)),
    skipArchiveCache: parseBoolean(search.get(URL_PARAM_NAMES.skipArchiveCache)),
    skipCidCache: parseBoolean(search.get(URL_PARAM_NAMES.skipCidCache)),
    skipWorkerCache: parseBoolean(search.get(URL_PARAM_NAMES.skipWorkerCache)),
  };
}

/** Canonicalize `search` in place to mirror `settings`, dropping default-valued axes. Returns true if mutated. */
export function writeSettingsToSearch(settings: Settings, search: URLSearchParams): boolean {
  const before = search.toString();
  applyAxis({
    search,
    key: URL_PARAM_NAMES.network,
    desired: settings.network === getDefaultNetwork() ? null : settings.network,
  });
  applyAxis({
    search,
    key: URL_PARAM_NAMES.backend,
    desired: settings.backend === getDefaultBackend() ? null : settings.backend,
  });
  applyBooleanAxis({
    search,
    key: URL_PARAM_NAMES.skipArchiveCache,
    current: settings.cache.skipArchiveCache,
    defaultValue: DEFAULT_CACHE.skipArchiveCache,
  });
  applyBooleanAxis({
    search,
    key: URL_PARAM_NAMES.skipCidCache,
    current: settings.cache.skipCidCache,
    defaultValue: DEFAULT_CACHE.skipCidCache,
  });
  applyBooleanAxis({
    search,
    key: URL_PARAM_NAMES.skipWorkerCache,
    current: settings.cache.skipWorkerCache,
    defaultValue: DEFAULT_CACHE.skipWorkerCache,
  });
  return search.toString() !== before;
}

function parseBoolean(raw: string | null): boolean | null {
  if (raw === null || !VALID_BOOLEAN_FLAGS.has(raw)) {
    return null;
  }
  return raw === '1';
}

function applyAxis({ search, key, desired }: AxisParams): void {
  if (desired === null) {
    search.delete(key);
    return;
  }
  search.set(key, desired);
}

function applyBooleanAxis({ search, key, current, defaultValue }: BooleanAxisParams): void {
  if (current === defaultValue) {
    applyAxis({ search, key, desired: null });
    return;
  }
  applyAxis({ search, key, desired: current ? '1' : '0' });
}
