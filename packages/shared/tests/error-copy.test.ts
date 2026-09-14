// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { endpointHost, gatewayUnreachable } from "@dotli/shared/error-copy";

describe("gatewayUnreachable", () => {
  it("As a visitor, I am told which provider could not be reached", () => {
    expect(gatewayUnreachable("ipfs.example.io")).toBe(
      "Your browser couldn't connect to the trusted provider ipfs.example.io.",
    );
  });

  it("As a visitor, I get a readable sentence when no provider is configured", () => {
    expect(gatewayUnreachable(undefined)).toBe(
      "Your browser couldn't connect to the trusted provider.",
    );
  });

  it("As a visitor, I never see a gap where a provider name should be", () => {
    expect(gatewayUnreachable("")).toBe(
      "Your browser couldn't connect to the trusted provider.",
    );
  });

  // The caller supplies the host, never the noun. A caller that passes its own
  // "a trusted provider" fallback renders "the trusted provider a trusted
  // provider", which is the bug this sentence is shaped to make impossible.
  it("As a visitor, I never read the words trusted provider twice in a row", () => {
    expect(gatewayUnreachable(undefined)).not.toContain("provider a trusted");
    expect(gatewayUnreachable("ipfs.example.io")).toContain(
      "the trusted provider ipfs.example.io.",
    );
  });
});

describe("endpointHost", () => {
  it("As a visitor, a wss endpoint is shown to me as a bare hostname", () => {
    expect(endpointHost("wss://paseo-asset-hub-next-rpc.polkadot.io")).toBe(
      "paseo-asset-hub-next-rpc.polkadot.io",
    );
  });

  it("As a visitor, an https endpoint with a path and port is shown to me as a bare hostname", () => {
    expect(endpointHost("https://gateway.example.io:8443/ipfs/")).toBe(
      "gateway.example.io",
    );
  });

  it("As a caller, a missing endpoint yields no hostname", () => {
    expect(endpointHost(undefined)).toBeUndefined();
  });

  it("As a caller, an empty endpoint yields no hostname", () => {
    expect(endpointHost("")).toBeUndefined();
  });

  // An unparseable value is still more use to a visitor than nothing, since it
  // is what an operator would have typed into the config.
  it("As a caller, an unparseable endpoint comes back verbatim", () => {
    expect(endpointHost("not a url")).toBe("not a url");
  });
});
