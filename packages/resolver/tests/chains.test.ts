import { describe, expect, it } from "vitest";
import { getActiveSupportedGenesisHashes } from "@dotli/config/network";
import { isChainSupported } from "@dotli/resolver/chains";

describe("isChainSupported", () => {
  it("accepts every chain the host runtime can expose", () => {
    for (const genesisHash of getActiveSupportedGenesisHashes()) {
      expect(isChainSupported(genesisHash)).toBe(true);
    }
  });

  it("rejects unknown genesis hashes", () => {
    expect(isChainSupported("0xdeadbeef")).toBe(false);
  });
});
