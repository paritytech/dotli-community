// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Unlike the display formatters in format.ts, the export truncates nothing.

import { toHex } from '@dotli/shared';

import type { StoredEvent } from './event-store.js';
import type { FilterState } from './filters.js';
import { isUint8ArrayLike } from './format.js';

export interface ExportMeta {
  exportedAt: string;
  url: string;
  userAgent: string;
  capacity: number;
  droppedCount: number;
  totalEvents: number;
  exportedEvents: number;
  filters: FilterState;
}

function makeExportReplacer(): (this: unknown, k: string, v: unknown) => unknown {
  const seen = new WeakSet();
  return function replacer(_k, v) {
    if (typeof v === 'bigint') {
      return `${v.toString()}n`;
    }
    if (isUint8ArrayLike(v)) {
      return { __type: 'Uint8Array', length: v.length, hex: toHex(v) };
    }
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) {
        return '[Circular]';
      }
      seen.add(v);
    }
    return v;
  };
}

export function buildExport(events: readonly StoredEvent[], meta: ExportMeta): string {
  try {
    return JSON.stringify({ meta, events }, makeExportReplacer(), 2);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ meta, error: `serialization failed: ${reason}` }, makeExportReplacer(), 2);
  }
}

export function exportFilename(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  return `dotli-debug-${stamp}.json`;
}
