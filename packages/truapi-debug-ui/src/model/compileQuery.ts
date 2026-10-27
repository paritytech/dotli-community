// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type CompiledQuery = {
  /** Takes a lowercased haystack. Null when the query imposes no constraint. */
  test: ((haystack: string) => boolean) | null;
  invalid: boolean;
};

type Params = {
  /** The entry count past which the cache starts over. */
  limit: number;
};

/**
 * The test a filter query stands for, kept for a repeated query. A `/regex/` that does not parse comes back `invalid`,
 * never thrown.
 */
export const compileQuery: (raw: string) => CompiledQuery = withBoundedCache(parseQuery, { limit: 16 });

/** The test a filter query stands for. A `/regex/` that does not parse comes back `invalid`, never thrown. */
function parseQuery(raw: string): CompiledQuery {
  const trimmed = raw.trim();
  if (trimmed.length > 1 && trimmed.startsWith('/') && trimmed.endsWith('/')) {
    try {
      const pattern = new RegExp(trimmed.slice(1, -1), 'i');
      return { test: h => pattern.test(h), invalid: false };
    } catch {
      return { test: null, invalid: true };
    }
  }
  const needle = trimmed.toLowerCase();
  return { test: needle === '' ? null : h => h.includes(needle), invalid: false };
}

/** `compute` with its results kept per key, all dropped once more than `limit` are held. Throws only what `compute` throws. */
function withBoundedCache<Output>(compute: (key: string) => Output, { limit }: Params): (key: string) => Output {
  const cache = new Map<string, Output>();
  return computeCached;

  function computeCached(key: string): Output {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (cache.size > limit) {
      cache.clear();
    }
    const output = compute(key);
    cache.set(key, output);
    return output;
  }
}
