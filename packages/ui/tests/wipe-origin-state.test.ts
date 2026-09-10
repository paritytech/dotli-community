// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dotli/ui/shared-auth", () => ({
  getSharedAuth: () => ({
    read: () => null,
    write: () => {},
    subscribe: () => () => {},
  }),
}));

describe("full reset", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("As a dotli user, resetting my settings keeps the colour scheme I chose", async () => {
    // Given
    localStorage.setItem("dotli-theme", "light");
    localStorage.setItem("dotli:network", "paseo");
    const { wipeOriginState } = await import("@dotli/ui/topbar");

    // When
    await wipeOriginState();

    // Then
    // The wipe preserves this now, so callers no longer snapshot it themselves.
    expect(localStorage.getItem("dotli-theme")).toBe("light");
    expect(localStorage.getItem("dotli:network")).toBeNull();
  });

  it("As a dotli user who never picked a theme, the reset does not invent one", async () => {
    // Given
    localStorage.setItem("dotli:network", "paseo");
    const { wipeOriginState } = await import("@dotli/ui/topbar");

    // When
    await wipeOriginState();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBeNull();
    expect(localStorage.getItem("dotli:network")).toBeNull();
  });
});
