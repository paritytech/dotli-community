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
  it("passes the full host runtime contract to the WASM core", () => {
    expect(
      createTruapiRuntimeConfig(
        "acme",
        {
          hostname: "host.dot.li",
          origin: "https://host.dot.li",
        } as Location,
        "dot.li",
      ),
    ).toEqual({
      productId: "acme.dot",
      productLabel: "acme",
      siteId: "dot.li",
      hostName: "Polkadot Web",
      hostIcon: "https://host.dot.li/dotli.png",
      hostVersion: undefined,
      platformType: expect.any(String),
      platformVersion: undefined,
      peopleChainGenesisHash: getActiveServicesConfig().people.genesis,
      pairingDeeplinkScheme: "polkadotapp",
    });
  });
});
