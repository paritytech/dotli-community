// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { getThemeState, setTheme, themeStore } from "../../src/state/theme.js";
import { resetStores, settle } from "../helpers/solid.js";

describe("theme store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the prerendered shell, the theme store defaults to system/dark without reading matchMedia", () => {
    expect(getThemeState()).toEqual({ pref: "system", resolved: "dark" });
  });

  it("As the TrUAPI theme bridge, setTheme still fires a plain dotli:theme-changed event", async () => {
    // Given
    let fired = 0;
    const listener = (): void => {
      fired += 1;
    };
    window.addEventListener("dotli:theme-changed", listener);

    // When
    setTheme({ pref: "light", resolved: "light" });
    await settle();

    // Then
    expect(fired).toBe(1);
    expect(themeStore.get()).toEqual({ pref: "light", resolved: "light" });
    window.removeEventListener("dotli:theme-changed", listener);
  });
});
