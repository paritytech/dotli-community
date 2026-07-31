// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug export
//
// Pure serialization of stored debug events for file download and
// clipboard copy. Unlike format.ts (display-oriented, truncated
// previews), output here is full fidelity: complete hex for
// Uint8Array, whole strings. No DOM in this module.

import { toHex } from "@dotli/shared/hex";

import type { StoredEvent } from "./event-store.ts";
import type { FilterState } from "./filters.ts";
import { isUint8ArrayLike } from "./format.ts";

/** Context block written alongside the events so an exported file is
 *  self-describing: what page produced it, how full the ring buffer
 *  was, and which filters were active (exports are filtered views). */
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

/**
 * Full-fidelity JSON.stringify replacer:
 * - Uint8Array becomes { __type: "Uint8Array", length, hex } with the
 *   COMPLETE hex string (no preview cap)
 * - bigint becomes a string with trailing "n"
 * - cycles become "[Circular]"
 * - strings are never truncated
 */
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

/**
 * Serialize events + meta to pretty-printed JSON. Never throws: if an
 * exotic payload defeats the replacer, the result is still a valid
 * JSON document with an `error` field in place of `events`.
 */
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

/** `dotli-debug-2026-07-31T14-30-00.json` — ISO timestamp with `:`
 *  swapped for `-` (Windows-safe filename). */
export function exportFilename(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
  return `dotli-debug-${stamp}.json`;
}
