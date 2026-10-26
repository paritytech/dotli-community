// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { TIMEOUTS } from '@dotli/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBitswapBridge, hostOriginRule, type BitswapBridge } from './bitswap-bridge.js';

const HOST = 'https://doom.dot.li';

type Harness = {
  bridge: BitswapBridge;
  /** What the bridge posted to its parent, in order. */
  posted: unknown[];
  parent: Window;
  /** A message arriving on the sandbox's window. */
  receive: (data: unknown, source: unknown, origin?: string) => void;
  /** The sandbox's page going away, for good or into the back/forward cache. */
  pagehide: (persisted: boolean) => void;
};

/** The sandbox's window and its host parent, as fakes the test drives. `refuseAborts` makes posting an abort throw. */
function harness({ refuseAborts = false }: { refuseAborts?: boolean } = {}): Harness {
  const target = new EventTarget();
  const posted: unknown[] = [];
  const parent = {
    postMessage: (message: unknown) => {
      if (refuseAborts && (message as { type?: unknown }).type === 'dotli:bitswap-abort') {
        throw new Error('the host window is gone');
      }
      posted.push(message);
    },
  } as unknown as Window;
  const bridge = createBitswapBridge({ window: target, parent, isHostOrigin: origin => origin === HOST });
  return {
    bridge,
    posted,
    parent,
    receive: (data, source, origin = HOST) => {
      // Node's MessageEvent refuses a source that is not a port, so the message carries its fields by hand.
      target.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
    },
    pagehide: persisted => {
      target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    },
  };
}

function abortMessages(posted: unknown[]): { ids: string[]; frame?: string }[] {
  return posted.filter(
    (m): m is { type: string; ids: string[]; frame?: string } =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'dotli:bitswap-abort',
  );
}

function getMessages(posted: unknown[]): { id: string; frame?: string }[] {
  return posted.filter(
    (m): m is { type: string; id: string; frame?: string } =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'dotli:bitswap-get',
  );
}

function requestId(posted: unknown[]): string {
  const request = posted.find(
    (m): m is { id: string } =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'dotli:bitswap-get',
  );
  if (request === undefined) {
    throw new Error('no block request posted');
  }
  return request.id;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sandbox bitswap bridge', () => {
  it("As a sandbox user, a block result posted by any window but my host is ignored and my fetch waits for the host's answer", async () => {
    // Given a block request the host is fetching
    const sandbox = harness();
    const pending = sandbox.bridge.requestBlock('bafyX');
    const id = requestId(sandbox.posted);
    const result = (byte: number): unknown => ({
      type: 'dotli:bitswap-result',
      id,
      ok: true,
      bytes: new Uint8Array([byte]),
    });

    // When a result arrives from another window, then from the parent on an untrusted origin, then from the host
    sandbox.receive(result(1), {});
    sandbox.receive(result(2), sandbox.parent, 'https://evil.example');
    sandbox.receive(result(3), sandbox.parent);

    // Then the fetch settles with the host's answer only
    await expect(pending).resolves.toEqual(new Uint8Array([3]));
  });

  it('As a user, leaving the page tells the host to stop fetching for it', async () => {
    // Given a block request the host has not answered
    const sandbox = harness();
    const pending = sandbox.bridge.requestBlock('bafyX');
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // When the frame goes away for good
    sandbox.pagehide(false);

    // Then the host was told which fetches to drop
    await settled;
    const aborts = abortMessages(sandbox.posted);
    expect(aborts).toHaveLength(1);
    expect(aborts[0]?.ids).toHaveLength(1);
  });

  it('As a user, leaving the page names this frame in the abort as in its requests, since the host reads it after the frame is gone', async () => {
    // Given two sandbox documents, each with a block request open
    const sandbox = harness();
    const other = harness();
    const pending = sandbox.bridge.requestBlock('bafyF');
    void other.bridge.requestBlock('bafyF');
    const settled = expect(pending).rejects.toThrow(/aborted/);

    // When
    sandbox.pagehide(false);

    // Then the abort repeats this document's frame, which no other document shares
    await settled;
    const frame = getMessages(sandbox.posted)[0]?.frame;
    expect(frame).toEqual(expect.any(String));
    expect(abortMessages(sandbox.posted)[0]?.frame).toBe(frame);
    expect(getMessages(other.posted)[0]?.frame).not.toBe(frame);
  });

  it('As a user, a page kept in the back/forward cache is not cancelled behind its back', async () => {
    // Given a block request still open as the page is frozen rather than closed
    const sandbox = harness();
    const pending = sandbox.bridge.requestBlock('bafyY');
    let settledEarly = false;
    void pending.catch(() => {
      settledEarly = true;
    });

    // When the frame is only being cached, so it can come back
    sandbox.pagehide(true);
    await Promise.resolve();

    // Then nothing was cancelled, because a restored frame would be left
    // awaiting a fetch the host had already abandoned
    expect(abortMessages(sandbox.posted)).toHaveLength(0);
    expect(settledEarly).toBe(false);
  });

  it('As an operator, a block the host failed to fetch keeps its error class across the bridge', async () => {
    // Given a block request the host is fetching
    const sandbox = harness();
    const pending = sandbox.bridge.requestBlock('bafyQ');

    // When the host answers that no peer had the block
    sandbox.receive(
      {
        type: 'dotli:bitswap-result',
        id: requestId(sandbox.posted),
        ok: false,
        error: 'bitswap_v1_get(bafyQ): provider discovery exhausted',
        errorName: 'BitswapNotFoundError',
        code: -32810,
      },
      sandbox.parent,
    );

    // Then the sandbox sees the same failure, not a generic Error that every
    // bitswap failure would share
    await expect(pending).rejects.toMatchObject({
      name: 'BitswapNotFoundError',
      message: 'bitswap_v1_get(bafyQ): provider discovery exhausted',
      code: -32810,
    });
  });

  it("As a sandbox whose host never answers a block, my request fails after the relay's budget and the host is told to stop", async () => {
    // Given a block request the host never answers
    vi.useFakeTimers();
    const sandbox = harness();
    const pending = sandbox.bridge.requestBlock('bafyT');
    const settled = expect(pending).rejects.toMatchObject({ name: 'BitswapBridgeTimeoutError' });
    const id = requestId(sandbox.posted);

    // When the relay's whole budget and the delivery grace pass
    vi.advanceTimersByTime(TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE);

    // Then the request failed by name and the host was told to drop that fetch
    await settled;
    expect(abortMessages(sandbox.posted)[0]?.ids).toEqual([id]);
  });

  it('As a sandbox whose host never answers and cannot be told to stop, my request still fails after the budget', async () => {
    // Given a block request the host never answers, on a parent that refuses the abort
    vi.useFakeTimers();
    const sandbox = harness({ refuseAborts: true });
    const pending = sandbox.bridge.requestBlock('bafyT');
    const settled = expect(pending).rejects.toMatchObject({ name: 'BitswapBridgeTimeoutError' });

    // When the relay's whole budget and the delivery grace pass
    vi.advanceTimersByTime(TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE);

    // Then
    await settled;
  });

  it('As a sandbox, a reply the host sends after my request timed out is ignored', async () => {
    // Given a block request that timed out
    vi.useFakeTimers();
    const sandbox = harness();
    const pending = sandbox.bridge.requestBlock('bafyT');
    const settled = expect(pending).rejects.toMatchObject({ name: 'BitswapBridgeTimeoutError' });
    const id = requestId(sandbox.posted);
    vi.advanceTimersByTime(TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE);
    await settled;

    // When the host's answer arrives late
    sandbox.receive({ type: 'dotli:bitswap-result', id, ok: true, bytes: new Uint8Array([1]) }, sandbox.parent);

    // Then the request keeps its timeout, and a later request is still answered
    await expect(pending).rejects.toMatchObject({ name: 'BitswapBridgeTimeoutError' });
    const next = sandbox.bridge.requestBlock('bafyU');
    const nextId = getMessages(sandbox.posted).at(-1)?.id;
    sandbox.receive({ type: 'dotli:bitswap-result', id: nextId, ok: true, bytes: new Uint8Array([2]) }, sandbox.parent);
    await expect(next).resolves.toEqual(new Uint8Array([2]));
  });

  it('As an operator, a teardown with nothing in flight stays silent', async () => {
    // Given no outstanding requests
    const sandbox = harness();

    // When the frame goes away
    sandbox.pagehide(false);

    // Then the host is not messaged at all
    await Promise.resolve();
    expect(abortMessages(sandbox.posted)).toHaveLength(0);
  });
});

describe('hostOriginRule', () => {
  it.each([
    ['https://doom.dot.li', true],
    ['https://dot.li', true],
    ['http://doom.localhost:4321', true],
    ['http://127.0.0.1:4321', true],
    ['https://local.host:4321', true],
    ['https://doom.local.host:4321', true],
    ['https://doom.app.local.host:4322', false],
    ['https://app.local.host:4321', false],
    ['http://doom.notlocal.host', false],
    ['https://doom.app.dot.li', false],
    ['http://doom.app.localhost:5174', false],
    ['http://doom.dot.li', false],
    ['https://dot.li.evil.example', false],
    ['not a url', false],
  ])('As a sandbox, I take %s as my host: %s', (origin, expected) => {
    // Given
    const isHostOrigin = hostOriginRule('dot.li');

    // When
    const trusted = isHostOrigin(origin);

    // Then
    expect(trusted).toBe(expected);
  });
});
