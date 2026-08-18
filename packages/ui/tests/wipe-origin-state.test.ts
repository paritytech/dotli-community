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

const ANALYTICS_KEY = "dotli:sentry-uuid";
const ID = "33333333-3333-4333-8333-333333333333";

describe("full reset", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("As a dotli user, resetting my settings does not turn me into a new person in analytics", async () => {
    // Given
    localStorage.setItem(ANALYTICS_KEY, ID);
    localStorage.setItem("dotli:network", "paseo");
    const { wipeOriginState } = await import("@dotli/ui/topbar");

    // When
    await wipeOriginState();

    // Then
    // The id describes the browser, not any of the state being reset.
    expect(localStorage.getItem(ANALYTICS_KEY)).toBe(ID);
    expect(localStorage.getItem("dotli:network")).toBeNull();
  });

  it("As a dotli user with no id yet, the reset does not invent one", async () => {
    // Given
    localStorage.setItem("dotli:network", "paseo");
    const { wipeOriginState } = await import("@dotli/ui/topbar");

    // When
    await wipeOriginState();

    // Then
    expect(localStorage.getItem(ANALYTICS_KEY)).toBeNull();
    expect(localStorage.getItem("dotli:network")).toBeNull();
  });
});
