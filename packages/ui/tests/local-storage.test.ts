import { beforeEach, describe, expect, it } from "vitest";
import {
  createLocalStorageClear,
  createLocalStorageRead,
  createLocalStorageWrite,
} from "@dotli/ui/host-callbacks/LocalStorage";

describe("local-storage host callbacks", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips product-scoped bytes", async () => {
    const read = createLocalStorageRead("dotli:myapp:");
    const write = createLocalStorageWrite("dotli:myapp:");
    const clear = createLocalStorageClear("dotli:myapp:");

    await write("key", new Uint8Array([0, 1, 2, 253, 254, 255]));

    expect(localStorage.getItem("dotli:myapp:key")).toBe("AAEC/f7/");
    expect(Array.from((await read("key")) ?? [])).toEqual([
      0, 1, 2, 253, 254, 255,
    ]);

    await clear("key");
    expect(await read("key")).toBeUndefined();
  });

  it("writes values larger than a single argument-spread chunk", async () => {
    const read = createLocalStorageRead("dotli:myapp:");
    const write = createLocalStorageWrite("dotli:myapp:");
    const value = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);

    await write("large", value);

    expect(Array.from((await read("large")) ?? [])).toEqual(Array.from(value));
  });
});
