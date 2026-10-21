// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { fetchFromIpfs, fetchCarFromIpfs } from './ipfs.js';

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const GATEWAY = 'https://gw.example';

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});

describe('fetchFromIpfs', () => {
  it('As the gateway fetcher, I fetch a raw block requesting format=raw with the ipld.raw Accept header so a content-negotiating gateway cannot mutate it', async () => {
    // Given a gateway that returns some block bytes
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    // When it fetches the block
    await fetchFromIpfs(CID, GATEWAY, fetchMock);

    // Then it asks for the raw binary block, not a content-negotiable GET
    // (a bare GET lets the gateway serve it as text/html and rewrite the body)
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=raw`,
      expect.objectContaining({
        headers: { Accept: 'application/vnd.ipld.raw' },
      }),
    );
  });

  it('As the gateway fetcher, I fetch a raw block and return its bytes and content type', async () => {
    // Given a gateway that returns raw bytes with a content type
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
        status: 200,
        headers: { 'content-type': 'application/vnd.ipld.raw' },
      }),
    );

    // When it fetches the block
    const { data, contentType } = await fetchFromIpfs(CID, GATEWAY, fetchMock);

    // Then it gets the response bytes and content type back
    expect(Array.from(data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(contentType).toBe('application/vnd.ipld.raw');
  });

  it('As the gateway fetcher, I fetch a raw block and a non-ok gateway response fails loudly', async () => {
    // Given a gateway that returns an error status
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

    // When it fetches the block
    // Then it rejects rather than returning a bad body, naming the gateway and
    // the CID so a report says which gateway failed on what
    await expect(fetchFromIpfs(CID, GATEWAY, fetchMock)).rejects.toThrow(`HTTP 502 from gw.example for ${CID}`);
  });

  it('As a visitor, I hit a gateway that answers with an error page and its transfer is stopped, not left open', async () => {
    // Given a gateway that answers with an error status and a body
    fetchMock.mockResolvedValue(new Response('<h1>Bad gateway</h1>', { status: 502 }));

    // When it fetches the block
    const fetched = fetchFromIpfs(CID, GATEWAY, fetchMock);

    // Then the fetch fails and the transfer it started is aborted
    await expect(fetched).rejects.toThrow('HTTP 502');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe('fetchCarFromIpfs', () => {
  it('As the gateway fetcher, I fetch a dag-pb archive requesting format=car with the ipld.car Accept header', async () => {
    // Given a gateway that returns some archive bytes
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    // When it fetches the archive
    await fetchCarFromIpfs(CID, GATEWAY, fetchMock);

    // Then it asks for the CAR archive as a binary type (immune to gateway
    // text/html rewriting, same discipline as the raw block path)
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=car`,
      expect.objectContaining({
        headers: { Accept: 'application/vnd.ipld.car' },
      }),
    );
  });

  it('As the gateway fetcher, I fetch a CAR archive and return its raw bytes', async () => {
    // Given a gateway that returns CAR bytes
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0xca, 0xfe]), { status: 200 }));

    // When it fetches the archive
    const data = await fetchCarFromIpfs(CID, GATEWAY, fetchMock);

    // Then it gets the response bytes back
    expect(Array.from(data)).toEqual([0xca, 0xfe]);
  });

  it('As the gateway fetcher, I fetch a CAR archive and a non-ok gateway response fails loudly', async () => {
    // Given a gateway that returns an error status
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

    // When it fetches the archive
    // Then it rejects rather than returning a bad body, naming the gateway and the CID
    await expect(fetchCarFromIpfs(CID, GATEWAY, fetchMock)).rejects.toThrow(`HTTP 502 from gw.example for ${CID}`);
  });
});

describe('gateway limits', () => {
  const TIGHT = { stallMs: 1, maxBytes: 4 };

  it('As a visitor, I load from a gateway that never answers and the load fails as stalled, so I can retry', async () => {
    // Given a gateway that never sends its headers
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    // When the block is fetched
    const fetched = fetchFromIpfs(CID, GATEWAY, fetchMock, TIGHT);

    // Then the fetch fails as stalled
    await expect(fetched).rejects.toMatchObject({ name: 'ContentGatewayStalledError' });
  });

  it('As a visitor, I load from a gateway that stops sending mid-body and the load fails as stalled', async () => {
    // Given a gateway that sends one part of the body and then nothing
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    // When the archive is fetched
    const fetched = fetchCarFromIpfs(CID, GATEWAY, fetchMock, TIGHT);

    // Then the fetch fails as stalled
    await expect(fetched).rejects.toMatchObject({ name: 'ContentGatewayStalledError' });
  });

  it('As a visitor, I load a gateway response larger than the cap and it fails instead of filling memory', async () => {
    // Given a gateway that sends more bytes than allowed
    fetchMock.mockResolvedValue(new Response(new Uint8Array(10), { status: 200 }));

    // When the archive is fetched
    const fetched = fetchCarFromIpfs(CID, GATEWAY, fetchMock, TIGHT);

    // Then the fetch fails as too large
    await expect(fetched).rejects.toMatchObject({ name: 'ContentGatewayTooLargeError' });
  });

  it('As a visitor, I load a response within the limits and it arrives whole', async () => {
    // Given a gateway that sends exactly as many bytes as allowed
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    // When the block is fetched
    const { data } = await fetchFromIpfs(CID, GATEWAY, fetchMock, TIGHT);

    // Then every byte arrives
    expect(Array.from(data)).toEqual([1, 2, 3, 4]);
  });
});
