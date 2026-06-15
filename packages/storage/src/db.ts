// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li shared IndexedDB connection.
//
// Single "dotli" database with stores for CID cache and smoldot chain data.
// Pre-opened during HTML parse via an inline <script> (window.__dotliDb).
//
// The pre-opened-handle path does not silently fall back to a fresh open
// when it rejects. A silent fallback would hide quota errors,
// upgrade-blocked, or origin-denied situations from operators. We log and
// capture the underlying rejection before falling back, so the warm-start
// failure is visible even though we still return a working DB.

import { log } from "@dotli/shared/log";
import { captureException } from "@dotli/metrics/sentry";

declare global {
  interface Window {
    __dotliDb?: Promise<IDBDatabase>;
  }
}

const DB_NAME = "dotli";
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

// Monotonic counter bumped every time a DB handle is replaced. Callers
// that cache a resolved handle and then hold a transaction open across
// an async boundary can check the generation to detect "the handle I
// was handed just got invalidated by onclose" instead of silently
// operating against a half-closed connection.
let dbGeneration = 0;

function openFresh(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cids")) {
        db.createObjectStore("cids", { keyPath: "label" });
      }
      if (!db.objectStoreNames.contains("chains")) {
        db.createObjectStore("chains", { keyPath: "chain" });
      }
      // v2: scheduled notifications + per-product id counters.
      if (!db.objectStoreNames.contains("scheduled_notifications")) {
        const store = db.createObjectStore("scheduled_notifications", {
          keyPath: "hostId",
          autoIncrement: true,
        });
        store.createIndex("byProductId", "productId", { unique: false });
        store.createIndex("byScheduledAt", "scheduledAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("notification_counters")) {
        // keyPath: "productId". Value: { productId, next: number }.
        db.createObjectStore("notification_counters", { keyPath: "productId" });
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      // Preserve the IDBError name + cause so callers can distinguish
      // VersionError / QuotaExceededError / InvalidStateError instead of
      // seeing one opaque message.
      const cause = req.error;
      reject(
        new Error(
          `Failed to open dotli DB: ${cause?.name ?? "unknown"}`,
          cause ? { cause } : undefined,
        ),
      );
    };
  });
}

/**
 * Get the shared database connection.
 * Reuses the pre-opened connection from window.__dotliDb if available.
 *
 * If the pre-opened handle rejects, the warm-start failure is logged and
 * captured to Sentry before we fall back to a fresh open, so the operator
 * can see *why* the optimization didn't fire instead of silently losing
 * the signal.
 */
export function getDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) {
    return dbPromise;
  }

  // Pick up the pre-opened connection from the inline HTML script
  if (typeof window !== "undefined" && window.__dotliDb) {
    dbPromise = window.__dotliDb.catch((err: unknown) => {
      log.error(
        "[dot.li db] Pre-opened DB handle rejected; falling back to fresh open:",
        err,
      );
      captureException(err, { kind: "db_pre_opened_rejected" });
      return openFresh();
    });
  } else {
    dbPromise = openFresh();
  }

  const thisGeneration = ++dbGeneration;

  // Reset on close so we re-open on next access. If the close fires while
  // the same generation is still current, clear the cached promise so the
  // next getDb() opens a fresh handle. If a later getDb() already bumped
  // the generation (racing refresh), leave it alone. Otherwise we'd null
  // out a newer, valid promise.
  void dbPromise
    .then((db) => {
      db.onclose = () => {
        if (dbGeneration === thisGeneration) {
          dbPromise = null;
        }
      };
    })
    .catch(() => {
      /* fire-and-forget */
    });

  return dbPromise;
}
