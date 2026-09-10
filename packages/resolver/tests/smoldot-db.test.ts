// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { createSmoldotDb } from "@dotli/resolver/smoldot-db";

const GENESIS =
  "0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd";
// Over the 100_000 byte floor, so `save` gets as far as opening the database.
const BLOB = "x".repeat(200_000);

/**
 * Hold `dotli-smoldot-db` open at version 1 and never let go, the way a tab
 * running the previous build does. That is what stops a version 2 upgrade in
 * another tab from running.
 */
function holdDatabaseAtV1(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("dotli-smoldot-db", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("chain-db");
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("open failed"));
    };
  });
}

describe("Light-client database", () => {
  it("As a user with a tab holding database v1, a new tab does not hang waiting for it to close", async () => {
    // Given
    const v1Tab = await holdDatabaseAtV1();
    const db = createSmoldotDb();
    expect(db).not.toBeNull();

    try {
      // When
      const started = Date.now();
      const outcome = await db!
        .save(GENESIS, BLOB)
        .then(() => "resolved")
        .catch((err: unknown) => String(err));
      const elapsed = Date.now() - started;

      // Then
      expect(outcome).toContain("blocked");
      expect(
        elapsed,
        "the new tab should give up straight away, not wait out the timeout",
      ).toBeLessThan(1_000);
    } finally {
      v1Tab.close();
    }
  });
});
