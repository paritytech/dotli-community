// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { compileQuery } from './compileQuery.js';
import type { FilterState } from './filterState.js';
import { getSystemEventKey } from './getSystemEventKey.js';
import type { StoredEvent, StoredTruapiEvent } from './storedEvent.js';

/** Whether `filters` let `event` through. A query that does not parse constrains nothing. Never throws. */
export function matchesFilters(event: StoredEvent, filters: FilterState): boolean {
  if (!matchesKind(event, filters)) {
    return false;
  }
  const haystack = getFilterText(event).toLowerCase();
  const include = compileQuery(filters.tagQuery).test;
  if (include?.(haystack) === false) {
    return false;
  }
  const exclude = compileQuery(filters.excludeQuery).test;
  return exclude?.(haystack) !== true;
}

function matchesKind(event: StoredEvent, filters: FilterState): boolean {
  switch (event.kind) {
    case 'truapi':
      return filters.showTruapi && matchesTruapi(event, filters);
    case 'system':
      return filters.showSystem;
  }
}

function matchesTruapi(event: StoredTruapiEvent, filters: FilterState): boolean {
  if (filters.direction !== 'both' && event.direction !== filters.direction) {
    return false;
  }
  if (filters.product === undefined) {
    return true;
  }
  return filters.product === (event.productId ?? null);
}

function getFilterText(event: StoredEvent): string {
  switch (event.kind) {
    case 'truapi':
      return event.tag;
    case 'system':
      return getSystemEventKey(event);
  }
}
