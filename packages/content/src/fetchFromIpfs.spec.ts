// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { fetchCarFromIpfs, fetchFromIpfs } from './fetchFromIpfs.js';

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const GATEWAY = 'https://gw.example';
const TIGHT = { stallMs: 1, maxBytes: 4 };

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});

describe('fetchFromIpfs', () => {
  it('As the gateway fetcher, I fetch a raw block requesting format=raw with the ipld.raw Accept header so a content-negotiating gateway cannot mutate it', async () => {
    // Given a gateway that returns some block bytes
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    // When it fetches the block
    await fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock });

    // Then it asks for the raw binary block, not a content-negotiable GET
    // (a bare GET lets the gateway serve it as text/html and rewrite the body)
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=raw`,
      expect.objectContaining({
        headers: { Accept: 'application/vnd.ipld.raw' },
      }),
    );
  });

  it('As the gateway fetcher, I fetch a raw block and a non-ok gateway response fails loudly', async () => {
    // Given a gateway that returns an error status
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

    // When it fetches the block
    const fetched = fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock });

    // Then it rejects rather than returning a bad body, naming the gateway and
    // the CID so a report says which gateway failed on what
    await expect(fetched).rejects.toThrow(`HTTP 502 from gw.example for ${CID}`);
  });

  it('As a visitor, I hit a gateway that answers with an error page and its transfer is stopped, not left open', async () => {
    // Given a gateway that answers with an error status and a body
    fetchMock.mockResolvedValue(new Response('<h1>Bad gateway</h1>', { status: 502 }));

    // When it fetches the block
    const fetched = fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock });

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
    await fetchCarFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock });

    // Then it asks for the CAR archive as a binary type (immune to gateway
    // text/html rewriting, same discipline as the raw block path)
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/ipfs/${CID}?format=car`,
      expect.objectContaining({
        headers: { Accept: 'application/vnd.ipld.car' },
      }),
    );
  });
});

describe('gateway limits', () => {
  it('As a visitor, I load from a gateway that never answers and the load fails as stalled, so I can retry', async () => {
    // Given a gateway that never sends its headers
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    // When the block is fetched
    const fetched = fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock, limits: TIGHT });

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
    const fetched = fetchCarFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock, limits: TIGHT });

    // Then the fetch fails as stalled
    await expect(fetched).rejects.toMatchObject({ name: 'ContentGatewayStalledError' });
  });

  it('As a visitor, I load a gateway response larger than the cap and it fails instead of filling memory', async () => {
    // Given a gateway that sends more bytes than allowed
    fetchMock.mockResolvedValue(new Response(new Uint8Array(10), { status: 200 }));

    // When the archive is fetched
    const fetched = fetchCarFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock, limits: TIGHT });

    // Then the fetch fails as too large
    await expect(fetched).rejects.toMatchObject({ name: 'ContentGatewayTooLargeError' });
  });

  it('As a visitor, I load a response within the limits and it arrives whole', async () => {
    // Given a gateway that sends exactly as many bytes as allowed
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    // When the block is fetched
    const { data } = await fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock, limits: TIGHT });

    // Then every byte arrives
    expect(Array.from(data)).toEqual([1, 2, 3, 4]);
  });
});

describe('an unreachable gateway', () => {
  it.each([
    ['Chromium', 'Failed to fetch'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ['Safari', 'Load failed'],
  ])(
    'As a visitor on %s, I load from a gateway my browser cannot reach and the load fails as unreachable, whatever the browser says',
    async (_browser, message) => {
      // Given a browser that could not send the request, in its own words
      const sendFailure = new TypeError(message);
      fetchMock.mockRejectedValue(sendFailure);

      // When the block is fetched
      const fetched = fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock });

      // Then the fetch fails as unreachable, naming the gateway and the CID, with the browser's error as its cause
      await expect(fetched).rejects.toMatchObject({
        name: 'ContentGatewayUnreachableError',
        message: `IPFS gateway gw.example unreachable for ${CID}`,
        cause: sendFailure,
      });
      // toMatchObject compares errors by value, so pin the very object the browser threw
      await expect(fetched).rejects.toSatisfy((error: Error) => error.cause === sendFailure);
    },
  );

  it('As a visitor, I leave while the gateway request is open and the load fails as a teardown, not as unreachable', async () => {
    // Given a frame torn down while its request is open
    const teardown = new DOMException('The frame went away', 'AbortError');
    fetchMock.mockRejectedValue(teardown);

    // When the block is fetched
    const fetched = fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock });

    // Then the fetch fails with the teardown itself
    await expect(fetched).rejects.toBe(teardown);
  });

  it('As a visitor, I load from a gateway that never answers and then drops the connection, and the load fails as stalled', async () => {
    // Given a gateway that never answers and drops the connection once the request is given up
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new TypeError('Failed to fetch'));
          });
        }),
    );

    // When the block is fetched
    const fetched = fetchFromIpfs(CID, { gateway: GATEWAY, fetch: fetchMock, limits: TIGHT });

    // Then the fetch fails as stalled
    await expect(fetched).rejects.toMatchObject({ name: 'ContentGatewayStalledError' });
  });
});
