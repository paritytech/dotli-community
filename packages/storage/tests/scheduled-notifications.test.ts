// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  schedule,
  cancel,
  allocateId,
  listForProduct,
  removeById,
  removeStale,
  type ScheduledNotificationRecord,
} from "@dotli/storage/scheduled-notifications";
import { getDb } from "@dotli/storage/db";

const RECORD_STORE = "scheduled_notifications";
const COUNTER_STORE = "notification_counters";

async function clearAll(): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([RECORD_STORE, COUNTER_STORE], "readwrite");
    tx.objectStore(RECORD_STORE).clear();
    tx.objectStore(COUNTER_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("clear failed"));
  });
}

function future(ms: number): number {
  return Date.now() + ms;
}

function past(ms: number): number {
  return Date.now() - ms;
}

describe("schedule", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("As a dapp, I schedule two notifications and get monotonic per-product ids starting at 1", async () => {
    // Given a product with no scheduled notifications

    // When the dapp schedules two
    const a = await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "first",
      deeplink: null,
      scheduledAt: future(60_000),
    });
    const b = await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "second",
      deeplink: null,
      scheduledAt: future(120_000),
    });

    // Then the ids increment from 1
    expect(a).toEqual({ ok: true, id: 1 });
    expect(b).toEqual({ ok: true, id: 2 });
  });

  it("As a dapp, my notification ids are counted independently per product", async () => {
    // Given two distinct products

    // When each schedules its first notification
    const a = await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "x",
      deeplink: null,
      scheduledAt: future(60_000),
    });
    const b = await schedule({
      productId: "bravo.dot",
      title: "Bravo",
      text: "y",
      deeplink: null,
      scheduledAt: future(60_000),
    });

    // Then both start at id 1
    expect(a).toEqual({ ok: true, id: 1 });
    expect(b).toEqual({ ok: true, id: 1 });
  });

  it("As a dapp, I hit ScheduleLimitReached on the 21st pending notification for one product", async () => {
    // Given a product already at the per-product cap of 20
    for (let i = 0; i < 20; i += 1) {
      const r = await schedule({
        productId: "acme.dot",
        title: "Acme",
        text: `n=${i}`,
        deeplink: null,
        scheduledAt: future(60_000 + i),
      });
      expect(r.ok).toBe(true);
    }

    // When it schedules one more
    const overflow = await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "overflow",
      deeplink: null,
      scheduledAt: future(120_000),
    });

    // Then the schedule is rejected with ScheduleLimitReached
    expect(overflow).toEqual({ ok: false, error: "ScheduleLimitReached" });
  });

  it("As a dapp, one product reaching the cap does not block another product", async () => {
    // Given acme is at the cap of 20
    for (let i = 0; i < 20; i += 1) {
      await schedule({
        productId: "acme.dot",
        title: "Acme",
        text: `n=${i}`,
        deeplink: null,
        scheduledAt: future(60_000 + i),
      });
    }

    // When a different product schedules
    const bravo = await schedule({
      productId: "bravo.dot",
      title: "Bravo",
      text: "ok",
      deeplink: null,
      scheduledAt: future(60_000),
    });

    // Then it succeeds at its own id 1
    expect(bravo).toEqual({ ok: true, id: 1 });
  });

  it("As a dapp, a cancelled notification does not free its id for reuse", async () => {
    // Given a scheduled notification that is then cancelled
    const first = await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "a",
      deeplink: null,
      scheduledAt: future(60_000),
    });
    expect(first).toEqual({ ok: true, id: 1 });
    await cancel("acme.dot", 1);

    // When the dapp schedules again
    const second = await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "b",
      deeplink: null,
      scheduledAt: future(60_000),
    });

    // Then the new id is 2, not the reclaimed 1
    expect(second).toEqual({ ok: true, id: 2 });
  });
});

describe("cancel", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("As a dapp, I cancel a pending notification and it is removed", async () => {
    // Given one pending notification
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "x",
      deeplink: null,
      scheduledAt: future(60_000),
    });

    // When the dapp cancels it
    const removed = await cancel("acme.dot", 1);

    // Then cancel reports success and the queue is empty
    expect(removed).toBe(true);
    expect(await listForProduct("acme.dot")).toEqual([]);
  });

  it("As a dapp, cancelling the same notification twice is idempotent", async () => {
    // Given one pending notification
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "x",
      deeplink: null,
      scheduledAt: future(60_000),
    });

    // When the dapp cancels it twice
    const first = await cancel("acme.dot", 1);
    const second = await cancel("acme.dot", 1);

    // Then the first removes it and the second is a no-op
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("As a dapp, I cannot cancel another product's notification", async () => {
    // Given acme has a pending notification
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "x",
      deeplink: null,
      scheduledAt: future(60_000),
    });

    // When a different product tries to cancel id 1
    const removed = await cancel("bravo.dot", 1);

    // Then nothing is removed and acme's notification survives
    expect(removed).toBe(false);
    expect(await listForProduct("acme.dot")).toHaveLength(1);
  });
});

describe("allocateId", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("As the immediate-fire path, I allocate an id without persisting a record", async () => {
    // Given a product with no scheduled notifications

    // When the immediate-fire path allocates an id
    const id = await allocateId("acme.dot");

    // Then it gets id 1 and nothing is queued
    expect(id).toBe(1);
    expect(await listForProduct("acme.dot")).toEqual([]);
  });

  it("As the immediate-fire path, allocateId and schedule share one monotonic counter", async () => {
    // Given an immediate allocation took id 1
    const a = await allocateId("acme.dot");
    expect(a).toBe(1);

    // When a scheduled notification and another allocation follow
    const b = await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "x",
      deeplink: null,
      scheduledAt: future(60_000),
    });
    const c = await allocateId("acme.dot");

    // Then ids stay monotonic across both paths
    expect(b).toEqual({ ok: true, id: 2 });
    expect(c).toBe(3);
  });
});

describe("listForProduct", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("As the scheduler, I list only the records belonging to a given product", async () => {
    // Given two products with interleaved schedules
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "a1",
      deeplink: null,
      scheduledAt: future(60_000),
    });
    await schedule({
      productId: "bravo.dot",
      title: "Bravo",
      text: "b1",
      deeplink: null,
      scheduledAt: future(60_000),
    });
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "a2",
      deeplink: null,
      scheduledAt: future(120_000),
    });

    // When listing one product
    const acme = await listForProduct("acme.dot");

    // Then only that product's records come back
    expect(acme.map((r: ScheduledNotificationRecord) => r.text).sort()).toEqual(
      ["a1", "a2"],
    );
  });
});

describe("removeById", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("As the scheduler, I remove a record by hostId and learn whether it existed", async () => {
    // Given one queued record
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "x",
      deeplink: null,
      scheduledAt: future(60_000),
    });
    const [rec] = await listForProduct("acme.dot");
    expect(rec).toBeDefined();

    // When removing it by hostId twice
    const first = await removeById(rec.hostId);
    const second = await removeById(rec.hostId);

    // Then the first reports it existed and the second does not
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await listForProduct("acme.dot")).toEqual([]);
  });
});

describe("removeStale", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("As the scheduler, I drop records older than the staleness cutoff and keep fresh ones", async () => {
    // Given one record older than the 24h window and one within it
    const dayMs = 24 * 60 * 60 * 1000;
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "old",
      deeplink: null,
      scheduledAt: past(dayMs + 60_000),
    });
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "fresh",
      deeplink: null,
      scheduledAt: past(60_000),
    });

    // When pruning stale records
    const removed = await removeStale(Date.now());

    // Then only the stale one is gone
    expect(removed).toBe(1);
    const remaining = await listForProduct("acme.dot");
    expect(remaining.map((r: ScheduledNotificationRecord) => r.text)).toEqual([
      "fresh",
    ]);
  });

  it("As the scheduler, removeStale reports 0 when nothing is stale", async () => {
    // Given a single fresh record
    await schedule({
      productId: "acme.dot",
      title: "Acme",
      text: "fresh",
      deeplink: null,
      scheduledAt: past(60_000),
    });

    // When pruning stale records
    const removed = await removeStale(Date.now());

    // Then nothing is removed
    expect(removed).toBe(0);
  });
});
