// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../helpers/solid";

const monitor = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    status: [] as unknown[],
    transfer: { bytesPerSecond: null, fetched: null, total: null } as unknown,
  };
});

vi.mock("@dotli/ui/network-monitor", () => ({
  subscribeNetwork: (l: () => void) => {
    monitor.listeners.add(l);
    return () => monitor.listeners.delete(l);
  },
  getNetworkStatus: () => monitor.status,
  getTransfer: () => monitor.transfer,
}));

describe("network store", () => {
  afterEach(() => {
    resetStores();
    monitor.listeners.clear();
  });

  it("As the chains popover, the store mirrors the monitor on every change after start", async () => {
    // Given
    const { getNetworkState, startNetworkStore } =
      await import("@dotli/ui/state/network");
    const stop = startNetworkStore();
    monitor.status = [{ role: "relay", label: "Relay" }];

    // When
    for (const l of monitor.listeners) {
      l();
    }

    // Then
    expect(getNetworkState().chains).toEqual([
      { role: "relay", label: "Relay" },
    ]);
    stop();
    expect(monitor.listeners.size).toBe(0);
  });

  it("As the host, the store does nothing until started", async () => {
    // Given
    const { getNetworkState } = await import("@dotli/ui/state/network");

    // Then
    expect(getNetworkState().chains).toEqual([]);
    expect(monitor.listeners.size).toBe(0);
  });
});
