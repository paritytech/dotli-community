// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  getPermissionsState,
  permissionsState,
  recordPermissionChange,
} from "@dotli/ui/state/permissions";
import { resetStores, settle } from "../helpers/solid";

function capture(name: string): { details: unknown[]; stop: () => void } {
  const details: unknown[] = [];
  const listener = (e: Event): void => {
    details.push((e as CustomEvent).detail);
  };
  window.addEventListener(name, listener);
  return {
    details,
    stop: () => {
      window.removeEventListener(name, listener);
    },
  };
}

describe("permissions store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the permissions popover, the store starts at version 0 with no change", () => {
    expect(getPermissionsState()).toEqual({ version: 0, last: null });
  });

  it("As a listener, a grant with no permission fires dotli:permission-changed { label } with no permission key", async () => {
    // Given
    const events = capture("dotli:permission-changed");

    // When
    recordPermissionChange({ kind: "grant", label: "myapp" });
    await settle();

    // Then
    expect(events.details).toEqual([{ label: "myapp" }]);
    expect("permission" in (events.details[0] as object)).toBe(false);
    expect(permissionsState()).toEqual({
      version: 1,
      last: { kind: "grant", label: "myapp" },
    });
    events.stop();
  });

  it("As the topbar, a grant with a permission fires dotli:permission-changed { label, permission }", async () => {
    // Given
    const events = capture("dotli:permission-changed");

    // When
    recordPermissionChange({
      kind: "grant",
      label: "myapp",
      permission: "camera",
    });
    await settle();

    // Then
    expect(events.details).toEqual([{ label: "myapp", permission: "camera" }]);
    expect(permissionsState()).toEqual({
      version: 1,
      last: { kind: "grant", label: "myapp", permission: "camera" },
    });
    events.stop();
  });

  it("As a listener, a device change fires dotli:device-permission-changed { label, permission }", () => {
    // Given
    const events = capture("dotli:device-permission-changed");

    // When
    recordPermissionChange({ kind: "device", label: "myapp", permission: "camera" });
    recordPermissionChange({ kind: "device", label: "myapp", permission: "camera" });

    // Then
    expect(events.details).toEqual([
      { label: "myapp", permission: "camera" },
      { label: "myapp", permission: "camera" },
    ]);
    expect(getPermissionsState().version).toBe(2);
    events.stop();
  });
});
