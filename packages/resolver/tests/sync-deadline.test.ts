// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { raceSyncTimeout, withSyncBudget } from "@dotli/resolver/sync-deadline";

const CAP_MS = 180_000;

describe("raceSyncTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a caller whose chain never syncs, I get a typed sync-timeout rejection", async () => {
    // Given
    const never = new Promise<string>(() => {
      /* never settles, like whenReady() with no reachable peers */
    });

    // When
    const raced = raceSyncTimeout(never, "Asset Hub Paseo", 5_000);
    const assertion = expect(raced).rejects.toMatchObject({
      name: "NetworkSyncTimeoutError",
      chain: "Asset Hub Paseo",
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    await assertion;
  });

  it("As a caller whose chain syncs in time, I get the work's value", async () => {
    // Given
    const work = Promise.resolve("synced");

    // When
    const result = await raceSyncTimeout(work, "Asset Hub Paseo", 5_000);

    // Then
    expect(result).toBe("synced");
  });

  it("As a caller whose work settles first, the timer is cleared rather than left running", async () => {
    // Given
    const work = Promise.resolve("synced");

    // When
    await raceSyncTimeout(work, "Asset Hub Paseo", CAP_MS);

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it("As a caller whose work rejects first, the timer is cleared rather than left running", async () => {
    // Given
    const work = Promise.reject(new Error("provider died"));

    // When
    await expect(
      raceSyncTimeout(work, "Asset Hub Paseo", CAP_MS),
    ).rejects.toThrow("provider died");

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withSyncBudget", () => {
  it("As a caller with no deadline, my wait keeps the cap the work already enforces", () => {
    // Given
    const work = Promise.resolve("synced");

    // When
    const bounded = withSyncBudget(work, "Asset Hub Paseo", undefined, CAP_MS);

    // Then
    expect(bounded).toBe(work);
  });

  it("As a caller whose budget is looser than the cap, my wait is left untouched", () => {
    // Given
    const work = Promise.resolve("synced");

    // When
    const bounded = withSyncBudget(work, "Asset Hub Paseo", CAP_MS, CAP_MS);

    // Then
    expect(bounded).toBe(work);
  });

  it("As a caller whose budget is tighter than the cap, my wait fails at my budget", async () => {
    // Given
    vi.useFakeTimers();
    const never = new Promise<string>(() => {
      /* never settles */
    });

    // When
    const bounded = withSyncBudget(never, "Asset Hub Paseo", 5_000, CAP_MS);
    const assertion = expect(bounded).rejects.toMatchObject({
      name: "NetworkSyncTimeoutError",
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    await assertion;
    vi.useRealTimers();
  });
});
