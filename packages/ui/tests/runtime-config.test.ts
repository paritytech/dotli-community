import { describe, expect, it } from "vitest";
import { getActiveServicesConfig } from "@dotli/config/network";
import {
  createTruapiRuntimeConfig,
  labelToProductId,
} from "@dotli/ui/runtime-config";

describe("labelToProductId", () => {
  it("maps dotli labels to .dot product ids", () => {
    expect(labelToProductId("acme")).toBe("acme.dot");
  });

  it("keeps localhost labels stable", () => {
    expect(labelToProductId("localhost:5174")).toBe("localhost:5174");
  });
});

describe("createTruapiRuntimeConfig", () => {
  it("accepts an explicit product id for local previews", () => {
    expect(
      createTruapiRuntimeConfig(
        "localhost:3000",
        {
          origin: "http://localhost:5173",
        } as Location,
        "truapi-playground.dot",
      ).productId,
    ).toBe("truapi-playground.dot");
  });

  it("passes the full host runtime contract to the WASM core", () => {
    expect(
      createTruapiRuntimeConfig(
        "acme",
        {
          hostname: "host.dot.li",
          origin: "https://host.dot.li",
        } as Location,
      ),
    ).toEqual({
      productId: "acme.dot",
      hostName: "Polkadot Web",
      hostIcon: undefined,
      hostVersion: undefined,
      platformType: expect.any(String),
      platformVersion: undefined,
      peopleChainGenesisHash: getActiveServicesConfig().people.genesis,
      pairingDeeplinkScheme: "polkadotapp",
    });
  });

  it("leaves host icon unset when the host runs on localhost", () => {
    expect(
      createTruapiRuntimeConfig(
        "localhost:3000",
        {
          origin: "http://localhost:5173",
        } as Location,
      ).hostIcon,
    ).toBeUndefined();
  });
});
