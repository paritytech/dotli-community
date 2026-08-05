// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug export
//
// Serializes stored debug events for file download and clipboard copy.
// Unlike the display formatters in format.ts, nothing is truncated.

import { toHex } from "@dotli/shared/hex";

import type { StoredEvent } from "./event-store.ts";
import type { FilterState } from "./filters.ts";
import { isUint8ArrayLike } from "./format.ts";

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

function makeExportReplacer(): (
  this: unknown,
  k: string,
  v: unknown,
) => unknown {
  const seen = new WeakSet();
  return function replacer(_k, v) {
    if (typeof v === "bigint") {
      return `${v.toString()}n`;
    }
    if (isUint8ArrayLike(v)) {
      return { __type: "Uint8Array", length: v.length, hex: toHex(v) };
    }
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) {
        return "[Circular]";
      }
      seen.add(v);
    }
    return v;
  };
}

export function buildExport(
  events: readonly StoredEvent[],
  meta: ExportMeta,
): string {
  try {
    return JSON.stringify({ meta, events }, makeExportReplacer(), 2);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return JSON.stringify(
      { meta, error: `serialization failed: ${reason}` },
      makeExportReplacer(),
      2,
    );
  }
}

/** `dotli-debug-2026-07-31T14-30-00.json` */
export function exportFilename(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
  return `dotli-debug-${stamp}.json`;
}
