// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { endpointHost, gatewayUnreachable } from "@dotli/shared/error-copy";

describe("gatewayUnreachable", () => {
  it("names the host when there is one", () => {
    expect(gatewayUnreachable("ipfs.example.io")).toBe(
      "Your browser couldn't connect to the trusted provider ipfs.example.io.",
    );
  });

  it("falls back to a sentence with no host when none is configured", () => {
    expect(gatewayUnreachable(undefined)).toBe(
      "Your browser couldn't connect to the trusted provider.",
    );
  });

  it("treats an empty host as no host rather than interpolating a gap", () => {
    expect(gatewayUnreachable("")).toBe(
      "Your browser couldn't connect to the trusted provider.",
    );
  });

  // The caller supplies the host, never the noun. A caller that passes its own
  // "a trusted provider" fallback renders "the trusted provider a trusted
  // provider", which is the bug this sentence is shaped to make impossible.
  it("supplies the noun itself, so the host slot is only ever a hostname", () => {
    expect(gatewayUnreachable(undefined)).not.toContain("provider a trusted");
    expect(gatewayUnreachable("ipfs.example.io")).toContain(
      "the trusted provider ipfs.example.io.",
    );
  });
});

describe("endpointHost", () => {
  it("takes the hostname off a wss:// endpoint", () => {
    expect(endpointHost("wss://paseo-asset-hub-next-rpc.polkadot.io")).toBe(
      "paseo-asset-hub-next-rpc.polkadot.io",
    );
  });

  it("takes the hostname off an https:// endpoint with a path and port", () => {
    expect(endpointHost("https://gateway.example.io:8443/ipfs/")).toBe(
      "gateway.example.io",
    );
  });

  it("returns undefined for a missing endpoint", () => {
    expect(endpointHost(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty endpoint", () => {
    expect(endpointHost("")).toBeUndefined();
  });

  // An unparseable value is still more use to a visitor than nothing, since it
  // is what an operator would have typed into the config.
  it("returns an unparseable endpoint verbatim", () => {
    expect(endpointHost("not a url")).toBe("not a url");
  });
});
