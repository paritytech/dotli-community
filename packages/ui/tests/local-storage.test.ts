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

  it("rotates SSO device identity across host runtime prefixes", async () => {
    const clear = createLocalStorageClear("dotli:localhost:3000:");
    localStorage.setItem("dotli:dotli:truapi:sso-device-identity:v1", "old");
    localStorage.setItem(
      "dotli:localhost:3000:truapi:sso-device-identity:v1",
      "old",
    );
    localStorage.setItem("dotli:myapp:other", "keep");

    await clear("truapi:sso-device-identity:v1");

    expect(
      localStorage.getItem("dotli:dotli:truapi:sso-device-identity:v1"),
    ).toBeNull();
    expect(
      localStorage.getItem(
        "dotli:localhost:3000:truapi:sso-device-identity:v1",
      ),
    ).toBeNull();
    expect(localStorage.getItem("dotli:myapp:other")).toBe("keep");
  });

  it("writes values larger than a single argument-spread chunk", async () => {
    const read = createLocalStorageRead("dotli:myapp:");
    const write = createLocalStorageWrite("dotli:myapp:");
    const value = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);

    await write("large", value);

    expect(Array.from((await read("large")) ?? [])).toEqual(Array.from(value));
  });
});
