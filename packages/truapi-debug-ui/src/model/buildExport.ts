// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The export truncates nothing.

import { getErrorMessage, toHex } from '@dotli/shared';

import type { FilterState } from './filterState.js';
import { formatBigInt } from './formatBigInt.js';
import { isUint8ArrayLike } from './isUint8ArrayLike.js';
import type { StoredEvent } from './storedEvent.js';

export type ExportMeta = {
  exportedAt: string;
  url: string;
  userAgent: string;
  capacity: number;
  droppedCount: number;
  totalEvents: number;
  exportedEvents: number;
  filters: FilterState;
};

/**
 * The JSON file of `events` beside `meta`. Events that cannot be serialized become the reason beside the meta, never
 * thrown.
 */
export function buildExport(events: readonly StoredEvent[], meta: ExportMeta): string {
  try {
    return JSON.stringify({ meta, events }, createExportReplacer(), 2);
  } catch (error) {
    const reason = getErrorMessage(error);
    return JSON.stringify({ meta, error: `serialization failed: ${reason}` }, createExportReplacer(), 2);
  }
}

function createExportReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet();
  return function replaceValue(_key, value) {
    if (typeof value === 'bigint') {
      return formatBigInt(value);
    }
    if (isUint8ArrayLike(value)) {
      return { __type: 'Uint8Array', length: value.length, hex: toHex(value) };
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value;
  };
}
