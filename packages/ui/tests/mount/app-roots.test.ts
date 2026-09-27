// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeAppRoot,
  disposeAppRoots,
  registerAppRoot,
} from "@dotli/ui/mount/app-roots";

describe("app roots", () => {
  afterEach(() => {
    disposeAppRoots();
  });

  it("As the shell, disposing a root runs its disposer exactly once", () => {
    // Given
    const dispose = vi.fn();
    registerAppRoot("page", dispose);

    // When
    disposeAppRoot("page");
    disposeAppRoot("page");
    disposeAppRoots();

    // Then
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("As the shell, disposing a root that was never registered does nothing", () => {
    // When / Then
    expect(() => {
      disposeAppRoot("loading");
      disposeAppRoots();
    }).not.toThrow();
  });

  it("As the shell, disposing one root leaves the other live", () => {
    // Given
    const page = vi.fn();
    const loading = vi.fn();
    registerAppRoot("page", page);
    registerAppRoot("loading", loading);

    // When
    disposeAppRoot("page");

    // Then
    expect(page).toHaveBeenCalledTimes(1);
    expect(loading).not.toHaveBeenCalled();
  });

  it("As the shell, disposing every root runs each live disposer once", () => {
    // Given
    const page = vi.fn();
    const loading = vi.fn();
    registerAppRoot("page", page);
    registerAppRoot("loading", loading);

    // When
    disposeAppRoots();
    disposeAppRoots();

    // Then
    expect(page).toHaveBeenCalledTimes(1);
    expect(loading).toHaveBeenCalledTimes(1);
  });

  it("As the shell, registering a root again disposes the one it replaces", () => {
    // Given
    const first = vi.fn();
    const second = vi.fn();
    registerAppRoot("page", first);

    // When
    registerAppRoot("page", second);

    // Then
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    // When
    disposeAppRoot("page");

    // Then
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("As the shell, replacing a root that was already disposed does not dispose it again", () => {
    // Given
    const first = vi.fn();
    registerAppRoot("loading", first);
    disposeAppRoot("loading");

    // When
    registerAppRoot("loading", vi.fn());

    // Then
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("As the shell, a disposer that disposes its own root again runs once", () => {
    // Given
    const dispose = vi.fn(() => {
      disposeAppRoot("page");
    });
    registerAppRoot("page", dispose);

    // When
    disposeAppRoots();

    // Then
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
