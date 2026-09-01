import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveServicesConfig,
  setNetworkOverride,
} from "@dotli/config/network";
import {
  createTruapiRuntimeConfig,
  labelToProductId,
} from "@dotli/ui/runtime-config";

describe("labelToProductId", () => {
  afterEach(() => {
    setNetworkOverride("paseo-next-v2");
  });

  it("As a dotli integrator, the host maps dotli labels to the active network's TLD", () => {
    expect(labelToProductId("acme")).toBe("acme.paseo");
  });

  // A product id built with the wrong TLD hashes to a different dotNS node, so
  // the host would read an empty record instead of failing loudly.
  it("As a dotli integrator, the host maps the same label to .testnet on previewnet", () => {
    setNetworkOverride("previewnet");
    expect(labelToProductId("acme")).toBe("acme.testnet");
  });

  it("As a dotli integrator, the host keeps localhost labels stable", () => {
    expect(labelToProductId("localhost:5174")).toBe("localhost:5174");
  });
});

describe("createTruapiRuntimeConfig", () => {
  it("As a dotli integrator, the host accepts an explicit product id for local previews", () => {
    expect(
      createTruapiRuntimeConfig("localhost:3000", "truapi-playground.dot")
        .productId,
    ).toBe("truapi-playground.dot");
  });

  it("As a dotli integrator, the host passes the full host runtime contract to the WASM core", () => {
    expect(createTruapiRuntimeConfig("acme")).toEqual({
      productId: "acme.paseo",
      host: {
        name: "Polkadot Web",
        icon: undefined,
        version: undefined,
      },
      platform: {
        type: expect.any(String),
        version: undefined,
      },
      people: {
        genesisHash: getActiveServicesConfig().people.genesis,
      },
      bulletin: {
        genesisHash: getActiveServicesConfig().bulletin.genesis,
      },
      assetHub: {
        genesisHash: getActiveServicesConfig().assethub.genesis,
      },
      pairing: {
        deeplinkScheme: "polkadotapp",
      },
    });
  });
});
