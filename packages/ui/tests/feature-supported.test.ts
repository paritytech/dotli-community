// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NetworkName,
  getActiveServicesConfig,
  setNetworkOverride,
} from "@dotli/config/network";
import { createFeatureSupported } from "@dotli/ui/host-callbacks/FeatureSupported";

const mocks = vi.hoisted(() => ({
  backend: "rpc-gateway",
}));

vi.mock("@dotli/config/mode", () => ({
  getBackend: () => mocks.backend,
}));

describe("product chain feature support", () => {
  beforeEach(() => {
    setNetworkOverride(NetworkName.PASEO_NEXT_V2);
    mocks.backend = "rpc-gateway";
  });

  it("keeps Bulletin internal in RPC gateway mode", async () => {
    const result = await createFeatureSupported()({
      value: { genesisHash: getActiveServicesConfig().bulletin.genesis },
    });

    expect(result).toEqual({ supported: false });
  });

  it("reports Bulletin support in smoldot mode", async () => {
    mocks.backend = "smoldot-shared-worker";

    const result = await createFeatureSupported()({
      value: { genesisHash: getActiveServicesConfig().bulletin.genesis },
    });

    expect(result).toEqual({ supported: true });
  });
});
