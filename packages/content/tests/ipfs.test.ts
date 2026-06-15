// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchFromIpfs, fetchCarFromIpfs } from "@dotli/content/ipfs";

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const GATEWAY = "https://gw.example";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFromIpfs", () => {
  // Regression guard: a bare GET lets a gateway content-negotiate and mutate
  // the body (e.g. Cloudflare rewriting text/html), so the bytes no longer
  // hash to the CID. We must request the raw block as a binary type.
  it("requests the raw block with ?format=raw and the raw Accept header", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await fetchFromIpfs(CID, GATEWAY);

    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=raw`,
      expect.objectContaining({
        headers: { Accept: "application/vnd.ipld.raw" },
      }),
    );
  });

  it("returns the response bytes and content type", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
        status: 200,
        headers: { "content-type": "application/vnd.ipld.raw" },
      }),
    );

    const { data, contentType } = await fetchFromIpfs(CID, GATEWAY);

    expect(Array.from(data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(contentType).toBe("application/vnd.ipld.raw");
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

    await expect(fetchFromIpfs(CID, GATEWAY)).rejects.toThrow(/502/);
  });
});

describe("fetchCarFromIpfs", () => {
  // CAR is also a binary type, so it is likewise immune to gateway text/html
  // rewriting — this asserts the request stays binary.
  it("requests the CAR archive with ?format=car and the CAR Accept header", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await fetchCarFromIpfs(CID, GATEWAY);

    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=car`,
      expect.objectContaining({
        headers: { Accept: "application/vnd.ipld.car" },
      }),
    );
  });

  it("returns the response bytes", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0xca, 0xfe]), { status: 200 }),
    );

    const data = await fetchCarFromIpfs(CID, GATEWAY);

    expect(Array.from(data)).toEqual([0xca, 0xfe]);
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

    await expect(fetchCarFromIpfs(CID, GATEWAY)).rejects.toThrow(/502/);
  });
});
