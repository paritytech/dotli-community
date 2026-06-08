import { describe, expect, it } from "vitest";
import {
  ASSET_HUB_PASEO_GENESIS,
  BULLETIN_PASEO_GENESIS,
  PASEO_RELAY_GENESIS,
  PEOPLE_PASEO_GENESIS,
} from "@dotli/config/config";
import { isChainSupported } from "@dotli/resolver/chains";

describe("isChainSupported", () => {
  it("accepts every chain the host runtime can expose", () => {
    expect(isChainSupported(PASEO_RELAY_GENESIS)).toBe(true);
    expect(isChainSupported(ASSET_HUB_PASEO_GENESIS)).toBe(true);
    expect(isChainSupported(BULLETIN_PASEO_GENESIS)).toBe(true);
    expect(isChainSupported(PEOPLE_PASEO_GENESIS)).toBe(true);
  });

  it("rejects unknown genesis hashes", () => {
    expect(isChainSupported("0xdeadbeef")).toBe(false);
  });
});
