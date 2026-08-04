// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li IndexedDB-backed cache mapping a label to its CID.
//
// Enables stale-while-revalidate: on repeat visits, render from
// the cached CID instantly while smoldot validates in the background.
//
// The canonical surface is the discriminated `getCachedCidResult` so
// callers can distinguish "miss" (run full resolution) from "error"
// (storage broken, surface to user). The legacy `getCachedCid` remains
// for incremental migration but collapses both into `null`.

import { getDb } from "./db";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { isValidDotLabel } from "@dotli/shared/html";
import { log } from "@dotli/shared/log";
import { captureException } from "@dotli/metrics/sentry";

const STORE = "cids";

interface CidEntry {
  label: string;
  cid: string;
  timestamp: number;
}

export type CidCacheResult =
  | { kind: "hit"; cid: string }
  | { kind: "miss" }
  | { kind: "error"; cause: unknown };

export async function getCachedCidResult(
  label: string,
): Promise<CidCacheResult> {
  const stop = m.timer(S.CACHE_READ_LATENCY);
  try {
    const db = await getDb();
    return await new Promise<CidCacheResult>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(label);
      req.onsuccess = () => {
        const entry = req.result as CidEntry | undefined;
        stop();
        resolve(
          entry === undefined
            ? { kind: "miss" }
            : { kind: "hit", cid: entry.cid },
        );
      };
      req.onerror = () => {
        stop();
        resolve({
          kind: "error",
          cause: req.error ?? new Error("IDB read error"),
        });
      };
    });
  } catch (cause) {
    stop();
    return { kind: "error", cause };
  }
}

/**
 * Legacy surface where `null` collapses cache miss and storage error.
 *
 * New callers should use `getCachedCidResult` so storage failures can be
 * surfaced rather than silently treated as "no cache".
 */
export async function getCachedCid(label: string): Promise<string | null> {
  const result = await getCachedCidResult(label);
  if (result.kind === "error") {
    log.error("[dot.li cid-cache] read error:", result.cause);
    captureException(result.cause, { kind: "cid_cache_read_error" });
    return null;
  }
  return result.kind === "hit" ? result.cid : null;
}

export const RECENT_KEY = "dotli_recent";
const MAX_RECENT = 8;

/**
 * Decode a stored recent list, dropping anything that isn't a usable label.
 *
 * Shared with the cross-subdomain transport in `@dotli/ui/recent-labels`,
 * which holds the same list under the shared-mode store.
 */
export function parseRecentLabels(raw: string | null): string[] {
  if (raw === null || raw === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((l): l is string => typeof l === "string" && isValidDotLabel(l))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function serializeRecentLabels(labels: string[]): string {
  return JSON.stringify(labels.slice(0, MAX_RECENT));
}

/** Put `label` at the front of `labels`, deduplicated and length-capped. */
export function withRecentLabel(labels: string[], label: string): string[] {
  return [label, ...labels.filter((l) => l !== label)].slice(0, MAX_RECENT);
}

/** Read this origin's recent list. The shared store is authoritative. */
export function getRecentLabels(): string[] {
  try {
    return parseRecentLabels(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

/**
 * Record a label as recently visited in this origin's mirror.
 *
 * Call this only once a label has actually resolved. Writing on navigation
 * intent persisted typos as pills that reproduce "can't be reached" forever.
 */
export function addRecentLabel(label: string): void {
  if (!isValidDotLabel(label)) {
    return;
  }
  writeRecentLabels(withRecentLabel(getRecentLabels(), label));
}

/** Drop a label from the recent list. Used by the pill's remove affordance. */
export function removeRecentLabel(label: string): void {
  const recent = getRecentLabels();
  if (!recent.includes(label)) {
    return;
  }
  writeRecentLabels(recent.filter((l) => l !== label));
}

export function writeRecentLabels(labels: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, serializeRecentLabels(labels));
    // eslint-disable-next-line no-restricted-syntax -- localStorage unavailable / quota exceeded when writing a UI-only "recent labels" list. Not worth a metric per page load; defaults keep working.
  } catch {
    /* non-critical. The recent list is UI decoration */
  }
}

export async function setCachedCid(label: string, cid: string): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, "readwrite");
    const entry: CidEntry = {
      label,
      cid,
      timestamp: Date.now(),
    };
    tx.objectStore(STORE).put(entry);
    stop();
  } catch (err) {
    stop();
    log.error("[dot.li cid-cache] write error:", err);
    captureException(err, { kind: "cid_cache_write_error" });
  }
}

/**
 * Clear every cached label-to-CID entry.
 *
 * Used when the user turns the dotNS cache off in settings. Awaits
 * transaction completion so a reload right after won't abort the clear
 * mid-flight. Best-effort: failures are logged.
 */
export async function clearCidCache(): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error("IDB clear error"));
      };
    });
    stop();
  } catch (err) {
    stop();
    log.error("[dot.li cid-cache] clear error:", err);
    captureException(err, { kind: "cid_cache_clear_error" });
  }
}

/** Remove a cached entry. Best-effort: failures are logged, not thrown. */
export async function evictCachedCid(label: string): Promise<void> {
  const stop = m.timer(S.CACHE_WRITE_LATENCY);
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(label);
    stop();
  } catch (err) {
    stop();
    log.error("[dot.li cid-cache] evict error:", err);
    captureException(err, { kind: "cid_cache_evict_error" });
  }
}

export type RevalidateOutcome =
  | { kind: "match" }
  | { kind: "update"; cid: string }
  | { kind: "cleared" };

/** Reconcile a freshly-resolved CID against the served one: write, evict, or noop. */
export async function recordRevalidateOutcome(
  label: string,
  servedCid: string,
  freshCid: string | null,
): Promise<RevalidateOutcome> {
  if (freshCid === null) {
    await evictCachedCid(label);
    m.count(S.CACHE_REVALIDATE_CLEARED);
    return { kind: "cleared" };
  }
  await setCachedCid(label, freshCid);
  if (freshCid === servedCid) {
    m.count(S.CACHE_REVALIDATE_MATCH);
    return { kind: "match" };
  }
  m.count(S.CACHE_REVALIDATE_UPDATE);
  return { kind: "update", cid: freshCid };
}
