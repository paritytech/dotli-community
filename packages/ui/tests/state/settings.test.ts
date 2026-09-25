// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { getSettingsState, initSettingsStore } from "@dotli/ui/state/settings";
import { getBackend, getCacheSettings } from "@dotli/config/mode";
import { getEnabledNetworks, getNetwork } from "@dotli/config/network";
import { resetStores } from "../helpers/solid";

describe("settings store", () => {
  afterEach(() => {
    resetStores();
    localStorage.clear();
  });

  it("As the prerendered shell, the settings store is empty until the host seeds it", () => {
    expect(getSettingsState()).toBeNull();
  });

  it("As the settings popover, initSettingsStore snapshots the config getters", () => {
    // When
    initSettingsStore();

    // Then
    expect(getSettingsState()).toEqual({
      backend: getBackend(),
      cache: getCacheSettings(),
      network: getNetwork(),
      enabledNetworks: getEnabledNetworks(),
    });
  });
});
