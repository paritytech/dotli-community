import { beforeEach, describe, expect, it } from "vitest";
import {
  createLocalStorageClear,
  createLocalStorageRead,
  createLocalStorageSubscribe,
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

  it("As a product, my storage subscription sees the current value, then each write and clear", async () => {
    // Given
    const key = "truapi:product-storage:v1:9:myapp.dot:watched";
    await createLocalStorageWrite()(key, new Uint8Array([1]));
    const items = createLocalStorageSubscribe()(key)[Symbol.asyncIterator]();

    // When
    const initial = await items.next();
    await createLocalStorageWrite()(key, new Uint8Array([2, 3]));
    const written = await items.next();
    await createLocalStorageClear()(key);
    const cleared = await items.next();
    await items.return?.();

    // Then
    expect(initial.value?._unsafeUnwrap()).toEqual({ value: "0x01" });
    expect(written.value?._unsafeUnwrap()).toEqual({ value: "0x0203" });
    expect(cleared.value?._unsafeUnwrap()).toEqual({});
  });

  it("As a product, my storage subscription ignores other keys and follows other tabs", async () => {
    // Given
    const key = "truapi:product-storage:v1:9:myapp.dot:watched";
    const items = createLocalStorageSubscribe()(key)[Symbol.asyncIterator]();
    await items.next();

    // When
    await createLocalStorageWrite()(
      "truapi:product-storage:v1:9:myapp.dot:other",
      new Uint8Array([9]),
    );
    localStorage.setItem(`dotli:${key}`, "BA==");
    window.dispatchEvent(new StorageEvent("storage", { key: `dotli:${key}` }));
    const fromOtherTab = await items.next();
    await items.return?.();

    // Then
    expect(fromOtherTab.value?._unsafeUnwrap()).toEqual({ value: "0x04" });
  });
});
