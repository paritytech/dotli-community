import { describe, expect, it } from "vitest";
import { getActiveServicesConfig } from "@dotli/config/network";
import {
  createTruapiRuntimeConfig,
  labelToProductId,
} from "@dotli/ui/runtime-config";

describe("labelToProductId", () => {
  it("As a dotli integrator, the host maps dotli labels to .dot product ids", () => {
    expect(labelToProductId("acme")).toBe("acme.dot");
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
      productId: "acme.dot",
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
      pairing: {
        deeplinkScheme: "polkadotapp",
      },
    });
  });
});
