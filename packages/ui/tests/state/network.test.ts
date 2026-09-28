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
    watching: false,
  };
});

vi.mock("@dotli/ui/network-monitor", () => ({
  subscribeNetwork: (l: () => void) => {
    monitor.listeners.add(l);
    return () => monitor.listeners.delete(l);
  },
  getNetworkStatus: () => monitor.status,
  getTransfer: () => monitor.transfer,
  startNetworkWatch: () => {
    monitor.watching = true;
  },
  stopNetworkWatch: () => {
    monitor.watching = false;
  },
}));

describe("network store", () => {
  afterEach(() => {
    resetStores();
    monitor.listeners.clear();
    Object.defineProperty(monitor, "status", {
      configurable: true,
      writable: true,
      value: [],
    });
    monitor.watching = false;
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

  it("As the host with no reader subscribed, monitor changes build no snapshot until one is read", async () => {
    // Given
    const { getNetworkState, networkStore, startNetworkStore } =
      await import("@dotli/ui/state/network");
    let reads = 0;
    const stop = startNetworkStore();
    const status = [{ role: "relay", label: "Relay" }];
    Object.defineProperty(monitor, "status", {
      configurable: true,
      get: () => {
        reads += 1;
        return status;
      },
    });

    // When: five notifications with nobody subscribed.
    for (let i = 0; i < 5; i += 1) {
      for (const l of monitor.listeners) {
        l();
      }
    }

    // Then
    expect(reads).toBe(0);
    expect(getNetworkState().chains).toEqual(status);
    expect(networkStore.get().chains).toEqual(status);
    expect(reads).toBe(1);

    // When: a reader subscribes, each notification builds one snapshot.
    const seen: unknown[] = [];
    const unsubscribe = networkStore.subscribe(() => {
      seen.push(networkStore.get().chains);
    });
    for (let i = 0; i < 2; i += 1) {
      for (const l of monitor.listeners) {
        l();
      }
    }

    // Then
    expect(reads).toBe(3);
    expect(seen).toHaveLength(2);
    unsubscribe();
    stop();
  });

  it("As the host, the store does nothing until started", async () => {
    // Given
    const { getNetworkState } = await import("@dotli/ui/state/network");

    // Then
    expect(getNetworkState().chains).toEqual([]);
    expect(monitor.listeners.size).toBe(0);
  });
  it("As the chains popover, watching starts the monitor's watch and re-reads it at once, and the stop ends the watch", async () => {
    // Given
    const { getNetworkState, startNetworkStore, watchNetwork } =
      await import("@dotli/ui/state/network");
    const stopStore = startNetworkStore();
    monitor.status = [{ role: "relay", label: "Relay", reachable: true }];

    // When: no notification comes with the watch starting.
    const before = Date.now();
    const stop = watchNetwork();

    // Then
    expect(monitor.watching).toBe(true);
    expect(getNetworkState().chains).toEqual([
      { role: "relay", label: "Relay", reachable: true },
    ]);
    expect(getNetworkState().readAt).toBeGreaterThanOrEqual(before);

    // When
    stop();

    // Then
    expect(monitor.watching).toBe(false);
    stopStore();
  });
});
