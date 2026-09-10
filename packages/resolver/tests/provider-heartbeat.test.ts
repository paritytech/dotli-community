// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getHandle` is not exercised here. It calls `init()` against the real
// truapi-provider wasm, which is not something a unit test should boot. The
// heartbeat is exported separately so its timing can be driven directly.

const gauge = vi.fn();

vi.mock("@dotli/metrics/metrics", () => ({
  m: {
    gauge: (...args: unknown[]) => {
      gauge(...args);
    },
  },
}));

async function loadHeartbeat(): Promise<(intervalMs?: number) => () => void> {
  const mod = await import("@dotli/resolver/provider");
  return mod.startLightClientHeartbeat;
}

describe("light client heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gauge.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a dotli operator, a light client is counted the moment it exists", async () => {
    // Given
    const startLightClientHeartbeat = await loadHeartbeat();

    // When
    const stop = startLightClientHeartbeat(60_000);

    // Then
    // Without this the first bucket reads zero while the client is already
    // syncing, and a reader counting startup points would miss the context.
    expect(gauge).toHaveBeenCalledTimes(1);
    expect(gauge).toHaveBeenCalledWith("smoldot.active", 1);
    stop();
  });

  it("As a dotli operator, a long-running light client keeps reporting", async () => {
    // Given
    const startLightClientHeartbeat = await loadHeartbeat();
    const stop = startLightClientHeartbeat(60_000);

    // When
    await vi.advanceTimersByTimeAsync(180_000);

    // Then
    // Three ticks on top of the startup emission. A client that stopped
    // reporting would silently drop out of the gauge while still running.
    expect(gauge).toHaveBeenCalledTimes(4);
    stop();
  });

  it("As a dotli operator, a stopped heartbeat reports nothing further", async () => {
    // Given
    const startLightClientHeartbeat = await loadHeartbeat();
    const stop = startLightClientHeartbeat(60_000);
    stop();
    gauge.mockClear();

    // When
    await vi.advanceTimersByTimeAsync(300_000);

    // Then
    expect(gauge).not.toHaveBeenCalled();
  });
});
