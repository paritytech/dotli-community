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

  it("As a dotli integrator, the host round-trips product-scoped bytes", async () => {
    // Given
    const read = createLocalStorageRead();
    const write = createLocalStorageWrite();
    const clear = createLocalStorageClear();

    // When
    await write(
      "truapi:product-storage:v1:9:myapp.dot:key",
      new Uint8Array([0, 1, 2, 253, 254, 255]),
    );

    // Then
    expect(
      localStorage.getItem("dotli:truapi:product-storage:v1:9:myapp.dot:key"),
    ).toBe("AAEC/f7/");
    expect(
      Array.from(
        (await read("truapi:product-storage:v1:9:myapp.dot:key")) ?? [],
      ),
    ).toEqual([0, 1, 2, 253, 254, 255]);

    await clear("truapi:product-storage:v1:9:myapp.dot:key");
    expect(
      await read("truapi:product-storage:v1:9:myapp.dot:key"),
    ).toBeUndefined();
  });

  it("As a dotli integrator, the host writes values larger than a single argument-spread chunk", async () => {
    // Given
    const read = createLocalStorageRead();
    const write = createLocalStorageWrite();
    const value = Uint8Array.from(
      { length: 70_000 },
      (_, index) => index % 256,
    );

    // When
    await write("truapi:product-storage:v1:9:myapp.dot:large", value);

    // Then
    expect(
      Array.from(
        (await read("truapi:product-storage:v1:9:myapp.dot:large")) ?? [],
      ),
    ).toEqual(Array.from(value));
  });
});
