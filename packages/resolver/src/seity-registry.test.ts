import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { Api, ContractStorage } from "./api";
import { computeNestedBytes32MappingSlot } from "./abi";
import { readSeitySlot } from "./seity-registry";

// The storage seity's registry contract wrote after `anchor(0x01…, 0x02…,
// 0x09…)` from 0xa1…, dumped by its mock host. The same keys are pinned in
// paritytech/seity `registry/lib.rs` (`storage_layout_is_what_raw_readers_compute`).
const DOMAIN = `0x${"01".repeat(32)}` as const;
const LOOKUP = `0x${"02".repeat(32)}` as const;
const DUMP: Record<string, string> = {
  "0x0178a5f3f52848d455b30bd72f348037540dbb9a30ce8884a49afb59d0a67708": `${"00".repeat(12)}${"a1".repeat(20)}`,
  "0xf88c0b9de2397b913259aa0787c071c0b839f71070f539761a5e34e4dff53926": "09".repeat(32),
  "0x3cb365a0a73e582cda498139ee151defc9301d55b78c813e1fd1149e92817660": `${"00".repeat(31)}01`,
};

function fakeApi(dump: Record<string, string>): Api {
  const storage: ContractStorage = {
    readSlot: (key) =>
      Promise.resolve(key in dump ? hexToBytes(dump[key]) : null),
  };
  return {
    whenReady: () => Promise.resolve(),
    withContract: (_address, read) => read(storage),
    onStop: () => () => undefined,
    destroy: () => undefined,
  };
}

describe("seity registry", () => {
  it("computes the slots the contract writes", () => {
    expect(Object.keys(DUMP)).toEqual([0, 1, 2].map((n) => computeNestedBytes32MappingSlot(DOMAIN, LOOKUP, n)));
  });

  it("reads an anchored slot", async () => {
    await expect(readSeitySlot(fakeApi(DUMP), "0xregistry", LOOKUP, DOMAIN)).resolves.toEqual({
      owner: `0x${"a1".repeat(20)}`,
      cidDigest: `0x${"09".repeat(32)}`,
      version: 1n,
    });
  });

  it("reads a never-anchored slot as version 0", async () => {
    const slot = await readSeitySlot(fakeApi({}), "0xregistry", LOOKUP, DOMAIN);
    expect(slot?.version).toBe(0n);
  });
});
