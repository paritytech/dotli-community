// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredEvent } from './event-store.js';

export type DirectionFilter = 'both' | 'incoming' | 'outgoing';

export interface FilterState {
  direction: DirectionFilter;
  /** `undefined` means no product filter. A `null` key matches events with `productId: undefined`. */
  product: string | null | undefined;
  /** Case-insensitive substring, or a regex when wrapped in slashes (`/boot|resolve/`). */
  tagQuery: string;
  /** Same syntax as `tagQuery`. Hides matches and wins over `tagQuery`. */
  excludeQuery: string;
  showTruapi: boolean;
  showSystem: boolean;
}

export function initialFilterState(): FilterState {
  return {
    direction: 'both',
    product: undefined,
    tagQuery: '',
    excludeQuery: '',
    showTruapi: true,
    showSystem: true,
  };
}

export interface CompiledQuery {
  /** Takes a lowercased haystack. Null when the query imposes no constraint. */
  test: ((haystack: string) => boolean) | null;
  invalid: boolean;
}

const compiled = new Map<string, CompiledQuery>();

export function compileQuery(raw: string): CompiledQuery {
  const hit = compiled.get(raw);
  if (hit !== undefined) {
    return hit;
  }
  if (compiled.size > 16) {
    compiled.clear();
  }
  const out = compile(raw);
  compiled.set(raw, out);
  return out;
}

function compile(raw: string): CompiledQuery {
  const q = raw.trim();
  if (q.length > 1 && q.startsWith('/') && q.endsWith('/')) {
    try {
      const re = new RegExp(q.slice(1, -1), 'i');
      return { test: h => re.test(h), invalid: false };
    } catch {
      return { test: null, invalid: true };
    }
  }
  const sub = q.toLowerCase();
  return { test: sub === '' ? null : h => h.includes(sub), invalid: false };
}

export function matches(ev: StoredEvent, f: FilterState): boolean {
  if (ev.kind === 'truapi') {
    if (!f.showTruapi) {
      return false;
    }
    if (f.direction !== 'both' && ev.direction !== f.direction) {
      return false;
    }
    if (f.product !== undefined) {
      const want = f.product;
      const got = ev.productId ?? null;
      if (want !== got) {
        return false;
      }
    }
  } else {
    if (!f.showSystem) {
      return false;
    }
  }
  const haystack = (ev.kind === 'truapi' ? ev.tag : `${ev.layer}:${ev.event}`).toLowerCase();
  const include = compileQuery(f.tagQuery).test;
  if (include?.(haystack) === false) {
    return false;
  }
  const exclude = compileQuery(f.excludeQuery).test;
  return exclude?.(haystack) !== true;
}
