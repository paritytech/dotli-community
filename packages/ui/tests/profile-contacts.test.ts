import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductContext } from "@parity/truapi-host";
import { fromHex } from "@dotli/shared/hex";
import { hashToCid } from "@dotli/content/preimage";
import { createProfilePlatform } from "@dotli/ui/host-callbacks/Profile";
import { parseContactsReference } from "@dotli/ui/profile/contacts-reference";
import { InvalidProfileReferenceError } from "@dotli/ui/profile/seity-reference";

// Produced by Seity's profile-core (`test/vectors/contacts-v1.json`): the
// reference a contact's host is handed, the registry slot it names, the two
// blobs it fetches (sealed record, re-sealed avatar), and what it must draw.
const VECTOR = JSON.parse(
  // happy-dom replaces import.meta.url, so resolve from the package root vitest runs in.
  readFileSync(join(process.cwd(), "tests/fixtures/seity-contacts-v1.json"), "utf8"),
) as {
  reference: string;
  registry: { lookupKey: `0x${string}`; cidDigest: `0x${string}`; version: number };
  blobs: Record<string, string>;
  expect: { avatarPlaintext: string; mood: { kind: string; intensity: string; setAt: number; ttlSecs: number } };
};

const mocks = vi.hoisted(() => ({
  bitswapGet: vi.fn(async (_cid: string): Promise<Uint8Array> => new Uint8Array()),
  resolveSeitySlotRemote: vi.fn(),
}));

vi.mock("@dotli/content/bitswap", () => ({ bitswapGet: mocks.bitswapGet }));
vi.mock("@dotli/content/ipfs", () => ({ fetchFromIpfs: vi.fn() }));
vi.mock("@dotli/config/mode", () => ({ getBackend: () => "smoldot-direct" }));
vi.mock("@dotli/protocol/client", () => ({ resolveSeitySlotRemote: mocks.resolveSeitySlotRemote }));

const product: ProductContext = { productId: "egui-chat.dot", executionKind: "App" };
const BLOBS_BY_CID = new Map(
  Object.entries(VECTOR.blobs).map(([digest, hex]) => [hashToCid(digest).toString(), fromHex(hex)]),
);

function drawer(): HTMLElement | null {
  return document.querySelector(".profile-drawer");
}

/** Two preimage polls (record, then avatar), each after the poller's first delay. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    if (drawer()?.querySelector(".profile-drawer-status")?.textContent !== "Loading profile…") {
      return;
    }
  }
  throw new Error("the drawer never finished loading");
}

describe("Seity contacts references", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // An hour after the vector's mood was set, so it is still current.
    vi.setSystemTime((VECTOR.expect.mood.setAt + 3600) * 1000);
    mocks.bitswapGet.mockReset();
    mocks.bitswapGet.mockImplementation(async (cid: string) => {
      const bytes = BLOBS_BY_CID.get(cid);
      if (bytes === undefined) throw new Error(`no blob for ${cid}`);
      return bytes;
    });
    mocks.resolveSeitySlotRemote.mockReset();
    mocks.resolveSeitySlotRemote.mockImplementation(async (lookupKey: string) =>
      lookupKey === VECTOR.registry.lookupKey
        ? { owner: `0x${"aa".repeat(20)}`, cidDigest: VECTOR.registry.cidDigest, version: "1" }
        : { owner: `0x${"00".repeat(20)}`, cidDigest: `0x${"00".repeat(32)}`, version: "0" },
    );
  });

  afterEach(() => {
    drawer()?.closest(".profile-drawer-backdrop")?.remove();
    vi.useRealTimers();
  });

  it("parses the reference profile-core writes", () => {
    expect(parseContactsReference(VECTOR.reference).lookupKey).toBe(VECTOR.registry.lookupKey);
  });

  it("resolves the slot, opens the record and draws the avatar with its mood", async () => {
    await createProfilePlatform().presentProfile(product, { reference: VECTOR.reference });
    await settle();

    expect(mocks.resolveSeitySlotRemote).toHaveBeenCalledWith(VECTOR.registry.lookupKey);
    expect(drawer()?.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
    expect(drawer()?.querySelector(".profile-drawer-mood")?.textContent).toBe("Hyped · loud · 23 h left");
    expect(drawer()?.querySelector(".profile-mood-ring")).not.toBeNull();
  });

  it("hides a lapsed mood but still draws the avatar", async () => {
    vi.setSystemTime((VECTOR.expect.mood.setAt + VECTOR.expect.mood.ttlSecs + 1) * 1000);
    await createProfilePlatform().presentProfile(product, { reference: VECTOR.reference });
    await settle();

    expect(drawer()?.querySelector("img")).not.toBeNull();
    expect(drawer()?.querySelector(".profile-mood-ring")).toBeNull();
  });

  it("says nothing is shared for a slot that was never anchored or was revoked", async () => {
    const other = `seity-contacts:v1:${"ab".repeat(32)}${"cd".repeat(32)}`;
    await createProfilePlatform().presentProfile(product, { reference: other });
    await settle();

    expect(drawer()?.querySelector(".profile-drawer-status")?.textContent).toBe(
      "This person is not sharing a profile right now.",
    );
  });

  it("rejects a malformed contacts reference without opening UI or echoing the seed", async () => {
    const bad = VECTOR.reference.slice(0, -2);
    const call = createProfilePlatform().presentProfile(product, { reference: bad });
    await expect(call).rejects.toBeInstanceOf(InvalidProfileReferenceError);
    await expect(call).rejects.not.toThrow(bad.slice(-64));
    expect(drawer()).toBeNull();
  });
});
