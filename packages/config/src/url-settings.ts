// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each subdomain is its own origin with its own localStorage, so URL params let a shared link carry settings.
// Default-valued axes are stripped, so a clean URL means every axis at default.
// Param names are inlined because they are the public URL contract.

import { defaultNetwork, isValidNetwork, type Network } from './network.js';
import { DEFAULT_CACHE, defaultBackend, parseBackend, type Backend } from './mode.js';
import type { Settings } from './settings.js';

const URL_PARAM_NAMES = {
  network: 'network',
  backend: 'chainBackend',
  skipArchiveCache: 'skipArchiveCache',
  skipCidCache: 'skipCidCache',
  skipWorkerCache: 'skipWorkerCache',
} as const;

const VALID_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['0', '1']);

/** Per-axis URL parse: `null` for absent or invalid, so callers can `?? fallback`. */
export interface ParsedUrlSettings {
  network: Network | null;
  backend: Backend | null;
  skipArchiveCache: boolean | null;
  skipCidCache: boolean | null;
  skipWorkerCache: boolean | null;
}

function parseBoolean(raw: string | null): boolean | null {
  if (raw === null || !VALID_BOOLEAN_FLAGS.has(raw)) {
    return null;
  }
  return raw === '1';
}

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
  applyAxis(search, URL_PARAM_NAMES.network, settings.network === defaultNetwork() ? null : settings.network);
  applyAxis(search, URL_PARAM_NAMES.backend, settings.backend === defaultBackend() ? null : settings.backend);
  applyBooleanAxis(
    search,
    URL_PARAM_NAMES.skipArchiveCache,
    settings.cache.skipArchiveCache,
    DEFAULT_CACHE.skipArchiveCache,
  );
  applyBooleanAxis(search, URL_PARAM_NAMES.skipCidCache, settings.cache.skipCidCache, DEFAULT_CACHE.skipCidCache);
  applyBooleanAxis(
    search,
    URL_PARAM_NAMES.skipWorkerCache,
    settings.cache.skipWorkerCache,
    DEFAULT_CACHE.skipWorkerCache,
  );
  return search.toString() !== before;
}

function applyAxis(search: URLSearchParams, key: string, desired: string | null): void {
  if (desired === null) {
    search.delete(key);
  } else {
    search.set(key, desired);
  }
}

function applyBooleanAxis(search: URLSearchParams, key: string, current: boolean, defaultValue: boolean): void {
  applyAxis(search, key, current === defaultValue ? null : current ? '1' : '0');
}
