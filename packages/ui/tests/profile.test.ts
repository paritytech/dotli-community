import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductContext } from "@parity/truapi-host";
import { fromHex } from "@dotli/shared/hex";
import { createProfilePlatform } from "@dotli/ui/host-callbacks/Profile";
import {
  InvalidProfileReferenceError,
  openSeityBlob,
  parseSeityBlobReference,
} from "@dotli/ui/profile/seity-reference";

// Produced with profile-core's primitives (product-sdk-crypto AES-256-GCM,
// Blake2b-256 digest, CIDv1 raw/Blake2b-256) over a 1x1 PNG: the interop
// contract this host must read.
const VECTOR = {
  reference:
    "bafk2bzacebczvuhgd5yzd4s3r7e4chyrkxct4vd4aoyla3hupu6osyd2b5wjq#0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20a0a1a2a3a4a5a6a7a8a9aaab",
  digest: "0x459ad0e61f7191f25b8fc9c11f1155c53e547c03b0b06cf47d3ce9607a0f6c98",
  ciphertext:
    "30817321f0bf400e7f0ea266b8cd64d657d7b018586860852f5dd5fd5251cdf1b8d199c8e29bf475790e5cfac6364e2519b7246683c6fed548e4cab58c72a92accc0e0947f8f7b4c1bff0d251d4f61314e90",
  plaintext:
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
} as const;
const WRONG_KEY_REFERENCE = VECTOR.reference.replace("#01", "#ff");

const mocks = vi.hoisted(() => ({
  bitswapGet: vi.fn(async (): Promise<Uint8Array> => new Uint8Array()),
}));

vi.mock("@dotli/content/bitswap", () => ({ bitswapGet: mocks.bitswapGet }));
vi.mock("@dotli/content/ipfs", () => ({ fetchFromIpfs: vi.fn() }));
vi.mock("@dotli/config/mode", () => ({ getBackend: () => "smoldot-direct" }));

const product: ProductContext = {
  productId: "egui-chat.dot",
  executionKind: "App",
};

function drawer(): HTMLElement | null {
  return document.querySelector(".profile-drawer");
}

async function settle(): Promise<void> {
  // Initial preimage poll, then the fetch, decrypt and render microtasks.
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => {
    expect(
      drawer()?.querySelector(".profile-drawer-status")?.textContent,
    ).not.toBe("Loading profile…");
  });
}

describe("Seity blob references", () => {
  it("reads the reference profile-core writes", async () => {
    const parsed = parseSeityBlobReference(VECTOR.reference);

    expect(parsed.preimageKey).toBe(VECTOR.digest);
    const plaintext = await openSeityBlob(
      fromHex(VECTOR.ciphertext) as Uint8Array<ArrayBuffer>,
      parsed,
    );
    expect(Array.from(plaintext)).toEqual(
      Array.from(fromHex(VECTOR.plaintext)),
    );
  });

  it("refuses to yield bytes under the wrong key", async () => {
    await expect(
      openSeityBlob(
        fromHex(VECTOR.ciphertext) as Uint8Array<ArrayBuffer>,
        parseSeityBlobReference(WRONG_KEY_REFERENCE),
      ),
    ).rejects.toMatchObject({ name: "OperationError" });
  });

  it.each([
    ["no fragment", VECTOR.reference.split("#")[0]],
    ["a short fragment", VECTOR.reference.slice(0, -2)],
    ["two fragments", `${VECTOR.reference}#00`],
    [
      "a sha2-256 CID",
      `bafkreigh2akiscaildc6ybwhxslp6rx2u4m2vpbhgvzhpsfkyzxiezxcnq#${VECTOR.reference.split("#")[1]}`,
    ],
  ])("rejects %s without echoing the capability", (_case, reference) => {
    expect(() => parseSeityBlobReference(reference)).toThrow(
      InvalidProfileReferenceError,
    );
    try {
      parseSeityBlobReference(reference);
    } catch (error) {
      expect(String(error)).not.toContain(VECTOR.reference.split("#")[1]);
    }
  });
});

describe("profile drawer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.bitswapGet.mockReset();
  });

  afterEach(() => {
    drawer()?.closest(".profile-drawer-backdrop")?.remove();
    vi.useRealTimers();
  });

  it("opens before the fetch completes, then shows the decrypted avatar", async () => {
    mocks.bitswapGet.mockResolvedValue(fromHex(VECTOR.ciphertext));

    await createProfilePlatform().presentProfile(product, {
      reference: VECTOR.reference,
    });

    expect(drawer()?.querySelector(".spinner")).not.toBeNull();
    expect(drawer()?.textContent).toContain("Shown by egui-chat.dot");
    await settle();
    const img = drawer()?.querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/^blob:/);
    expect(mocks.bitswapGet).toHaveBeenCalledWith(
      VECTOR.reference.split("#")[0],
      expect.any(AbortSignal),
    );
  });

  it("shows a failure in the drawer when the reference does not open", async () => {
    mocks.bitswapGet.mockResolvedValue(fromHex(VECTOR.ciphertext));

    await createProfilePlatform().presentProfile(product, {
      reference: WRONG_KEY_REFERENCE,
    });
    await settle();

    expect(drawer()?.querySelector("img")).toBeNull();
    expect(drawer()?.querySelector(".profile-drawer-status")?.textContent).toBe(
      "The profile could not be opened. The reference may be wrong or out of date.",
    );
  });

  it("rejects an unparseable reference without opening UI", async () => {
    await expect(
      createProfilePlatform().presentProfile(product, { reference: "nope" }),
    ).rejects.toBeInstanceOf(InvalidProfileReferenceError);
    expect(drawer()).toBeNull();
  });

  it("replaces the drawer on screen and closes on Escape", async () => {
    mocks.bitswapGet.mockReturnValue(new Promise<Uint8Array>(() => undefined));
    const platform = createProfilePlatform();

    await platform.presentProfile(product, { reference: VECTOR.reference });
    await platform.presentProfile(product, { reference: VECTOR.reference });
    expect(document.querySelectorAll(".profile-drawer")).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(drawer()).toBeNull();
  });
});
