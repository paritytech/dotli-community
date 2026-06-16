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
  it("As the gateway fetcher, I fetch a raw block requesting format=raw with the ipld.raw Accept header so a content-negotiating gateway cannot mutate it", async () => {
    // Given a gateway that returns some block bytes
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    // When it fetches the block
    await fetchFromIpfs(CID, GATEWAY);

    // Then it asks for the raw binary block, not a content-negotiable GET
    // (a bare GET lets the gateway serve it as text/html and rewrite the body)
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=raw`,
      expect.objectContaining({
        headers: { Accept: "application/vnd.ipld.raw" },
      }),
    );
  });

  it("As the gateway fetcher, I fetch a raw block and return its bytes and content type", async () => {
    // Given a gateway that returns raw bytes with a content type
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
        status: 200,
        headers: { "content-type": "application/vnd.ipld.raw" },
      }),
    );

    // When it fetches the block
    const { data, contentType } = await fetchFromIpfs(CID, GATEWAY);

    // Then it gets the response bytes and content type back
    expect(Array.from(data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(contentType).toBe("application/vnd.ipld.raw");
  });

  it("As the gateway fetcher, I fetch a raw block and a non-ok gateway response fails loudly", async () => {
    // Given a gateway that returns an error status
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

    // When it fetches the block
    // Then it rejects rather than returning a bad body
    await expect(fetchFromIpfs(CID, GATEWAY)).rejects.toThrow(/502/);
  });
});

describe("fetchCarFromIpfs", () => {
  it("As the gateway fetcher, I fetch a dag-pb archive requesting format=car with the ipld.car Accept header", async () => {
    // Given a gateway that returns some archive bytes
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    // When it fetches the archive
    await fetchCarFromIpfs(CID, GATEWAY);

    // Then it asks for the CAR archive as a binary type (immune to gateway
    // text/html rewriting, same discipline as the raw block path)
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=car`,
      expect.objectContaining({
        headers: { Accept: "application/vnd.ipld.car" },
      }),
    );
  });

  it("As the gateway fetcher, I fetch a CAR archive and return its raw bytes", async () => {
    // Given a gateway that returns CAR bytes
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0xca, 0xfe]), { status: 200 }),
    );

    // When it fetches the archive
    const data = await fetchCarFromIpfs(CID, GATEWAY);

    // Then it gets the response bytes back
    expect(Array.from(data)).toEqual([0xca, 0xfe]);
  });

  it("As the gateway fetcher, I fetch a CAR archive and a non-ok gateway response fails loudly", async () => {
    // Given a gateway that returns an error status
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

    // When it fetches the archive
    // Then it rejects rather than returning a bad body
    await expect(fetchCarFromIpfs(CID, GATEWAY)).rejects.toThrow(/502/);
  });
});
