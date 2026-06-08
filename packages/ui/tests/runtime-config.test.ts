import { describe, expect, it } from "vitest";
import { PEOPLE_PASEO_GENESIS } from "@dotli/config/config";
import {
  createTruapiRuntimeConfig,
  labelToProductId,
  pairingMetadataUrl,
} from "@dotli/ui/runtime-config";

describe("labelToProductId", () => {
  it("maps dotli labels to .dot product ids", () => {
    expect(labelToProductId("acme")).toBe("acme.dot");
  });

  it("keeps localhost labels stable", () => {
    expect(labelToProductId("localhost:5174")).toBe("localhost:5174");
  });
});

describe("pairingMetadataUrl", () => {
  it("uses the current origin outside localhost", () => {
    expect(
      pairingMetadataUrl({
        hostname: "app.paseo.li",
        origin: "https://app.paseo.li",
      } as Location),
    ).toBe("https://app.paseo.li/metadata.json");
  });

  it("maps localhost to the public dot.li metadata", () => {
    expect(
      pairingMetadataUrl({
        hostname: "localhost",
        origin: "http://localhost:5173",
      } as Location),
    ).toBe("https://dot.li/metadata.json");
  });

  it("maps localhost subdomains to matching dot.li subdomains", () => {
    expect(
      pairingMetadataUrl({
        hostname: "acme.localhost",
        origin: "http://acme.localhost:5174",
      } as Location),
    ).toBe("https://acme.dot.li/metadata.json");
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
      hostMetadataUrl: "https://host.dot.li/metadata.json",
      peopleChainGenesisHash: PEOPLE_PASEO_GENESIS,
      pairingDeeplinkScheme: "polkadotapp",
    });
  });
});
