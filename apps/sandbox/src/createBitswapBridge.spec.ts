// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { TIMEOUTS } from '@dotli/config';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { isRecord } from '@dotli/shared';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { catchError, createManualTimers, recordLog, type ManualTimers } from '@dotli/shared/testing';

import { createBitswapBridge, createHostOriginRule, type BitswapBridge } from './createBitswapBridge.js';
import { createCountingEventTarget } from './testing/createCountingEventTarget.js';

type Harness = {
  bridge: BitswapBridge;
  /** What the bridge posted to its parent, in order. */
  posted: unknown[];
  parent: Pick<Window, 'postMessage'>;
  /** A message arriving on the sandbox's window. */
  receive: (data: unknown, source: unknown, options?: { origin?: string }) => void;
  /** The sandbox's page going away, for good or into the back/forward cache. */
  hidePage: (persisted: boolean) => void;
};

const HOST = 'https://doom.dot.li';
const BLOCK_REQUEST = 'dotli:bitswap-get';
const BLOCK_ABORT = 'dotli:bitswap-abort';
const BLOCK_RESULT = 'dotli:bitswap-result';

/** The sandbox's window as the bridge and the harness use it. */
type SandboxWindow = Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;

/**
 * The sandbox's window and its host parent, as fakes the test drives. `refuseAborts` makes posting an abort throw.
 * `timers` are the clock and timers the bridge runs on. `target` is the sandbox's window.
 */
function createHarness({
  refuseAborts = false,
  timers = createManualTimers(),
  target = new EventTarget(),
}: { refuseAborts?: boolean; timers?: ManualTimers; target?: SandboxWindow } = {}): Harness {
  const posted: unknown[] = [];
  const parent: Pick<Window, 'postMessage'> = {
    postMessage(message: unknown) {
      if (refuseAborts && isRecord(message) && message['type'] === BLOCK_ABORT) {
        throw new Error('the host window is gone');
      }
      posted.push(message);
    },
  };
  const bridge = createBitswapBridge({ window: target, parent, isHostOrigin: origin => origin === HOST, timers });
  return {
    bridge,
    posted,
    parent,
    receive: (data, source, { origin = HOST } = {}) => {
      // Node's MessageEvent refuses a source that is not a port, so the message carries its fields by hand.
      target.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
    },
    hidePage: persisted => {
      target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    },
  };
}

/** The messages of `type` the bridge posted, in order. */
function filterPosted(posted: unknown[], type: string): Record<string, unknown>[] {
  return posted.filter(isRecord).filter(message => message['type'] === type);
}

/** The id of the latest block request the bridge posted. Throws when it posted none. */
function getRequestId(posted: unknown[]): string {
  const id = filterPosted(posted, BLOCK_REQUEST).at(-1)?.['id'];
  if (typeof id !== 'string') {
    throw new Error('no block request posted');
  }
  return id;
}

describe('sandbox bitswap bridge', () => {
  let sentry: RecordingSentry;

  beforeEach(() => {
    sentry = bindRecordingSentry();
  });

  afterEach(() => {
    sentry.restore();
  });

  it('As a sandbox user, I wait on a block and a result posted by any window but my host is ignored until the host answers', async () => {
    // Given a block request the host is fetching
    const sandbox = createHarness();
    const pending = sandbox.bridge.requestBlock('bafyX');
    const id = getRequestId(sandbox.posted);
    const buildResult = (byte: number): unknown => ({
      type: BLOCK_RESULT,
      id,
      ok: true,
      bytes: new Uint8Array([byte]),
    });

    // When a result arrives from another window, then from the parent on an untrusted origin, then from the host
    sandbox.receive(buildResult(1), {});
    sandbox.receive(buildResult(2), sandbox.parent, { origin: 'https://evil.example' });
    sandbox.receive(buildResult(3), sandbox.parent);

    // Then the fetch settles with the host's answer only
    await expect(pending).resolves.toEqual(new Uint8Array([3]));
  });

  it('As a user, I leave the page and the host is told to stop fetching for it', async () => {
    // Given a block request the host has not answered
    const sandbox = createHarness();
    const pending = sandbox.bridge.requestBlock('bafyX');
    const id = getRequestId(sandbox.posted);
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // When the frame goes away for good
    sandbox.hidePage(false);

    // Then the host was told which fetches to drop
    await settled;
    expect(filterPosted(sandbox.posted, BLOCK_ABORT)).toMatchObject([{ type: BLOCK_ABORT, ids: [id] }]);
  });

  it('As a user whose host cannot be told to stop, I leave the page and my open read aborts and the failed abort is logged and counted', async () => {
    // Given a block request the host has not answered, on a parent that refuses the abort
    const logs = recordLog({ onFinished: onTestFinished, level: 'error' });
    const sandbox = createHarness({ refuseAborts: true });
    const pending = sandbox.bridge.requestBlock('bafyX');
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // When the frame goes away for good
    sandbox.hidePage(false);

    // Then the read was aborted and the failed abort was reported
    await settled;
    expect(logs.map(line => line.args?.[0])).toEqual(['[dot.li sandbox] bitswap bridge abort postMessage failed:']);
    expect(sentry.counted('sandbox.bitswap_abort')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a user, I leave the page and its abort names this frame as its requests do, since the host reads it after the frame is gone', async () => {
    // Given two sandbox documents, each with a block request open
    const sandbox = createHarness();
    const other = createHarness();
    const pending = sandbox.bridge.requestBlock('bafyF');
    void other.bridge.requestBlock('bafyF');
    const settled = expect(pending).rejects.toThrow(/aborted/);

    // When
    sandbox.hidePage(false);

    // Then the abort repeats this document's frame, which no other document shares
    await settled;
    const frame = filterPosted(sandbox.posted, BLOCK_REQUEST)[0]?.['frame'];
    expect(frame).toEqual(expect.any(String));
    expect(filterPosted(sandbox.posted, BLOCK_ABORT)[0]?.['frame']).toBe(frame);
    expect(filterPosted(other.posted, BLOCK_REQUEST)[0]?.['frame']).not.toBe(frame);
  });

  it('As a user, I leave a page into the back/forward cache and its fetches are not cancelled behind its back', async () => {
    // Given a block request still open as the page is frozen rather than closed
    const sandbox = createHarness();
    const pending = sandbox.bridge.requestBlock('bafyY');
    let settledEarly = false;
    void pending.catch(() => {
      settledEarly = true;
    });

    // When the frame is only being cached, so it can come back
    sandbox.hidePage(true);
    await Promise.resolve();

    // Then nothing was cancelled, because a restored frame would be left
    // awaiting a fetch the host had already abandoned
    expect(filterPosted(sandbox.posted, BLOCK_ABORT)).toEqual([]);
    expect(settledEarly).toBe(false);
  });

  it('As an operator, I watch the host fail to fetch a block and its error class survives the bridge', async () => {
    // Given a block request the host is fetching
    const sandbox = createHarness();
    const pending = sandbox.bridge.requestBlock('bafyQ');

    // When the host answers that no peer had the block
    sandbox.receive(
      {
        type: BLOCK_RESULT,
        id: getRequestId(sandbox.posted),
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

  it("As a sandbox user whose host never answers a block, I wait out the relay's budget and my request fails while the host is told to stop", async () => {
    // Given a block request the host never answers
    const timers = createManualTimers();
    const sandbox = createHarness({ timers });
    const pending = sandbox.bridge.requestBlock('bafyT');
    const settled = expect(pending).rejects.toMatchObject({ name: 'BitswapBridgeTimeoutError' });
    const id = getRequestId(sandbox.posted);

    // When the relay's whole budget and the delivery grace pass
    await timers.advance(TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE);

    // Then the request failed by name and the host was told to drop that fetch
    await settled;
    expect(filterPosted(sandbox.posted, BLOCK_ABORT)).toMatchObject([{ type: BLOCK_ABORT, ids: [id] }]);
  });

  it('As a sandbox user whose host never answers and cannot be told to stop, I wait out the budget and my request still fails, with the failed abort logged and counted', async () => {
    // Given a block request the host never answers, on a parent that refuses the abort
    const logs = recordLog({ onFinished: onTestFinished, level: 'error' });
    const timers = createManualTimers();
    const sandbox = createHarness({ refuseAborts: true, timers });
    const pending = sandbox.bridge.requestBlock('bafyT');
    const settled = expect(pending).rejects.toMatchObject({ name: 'BitswapBridgeTimeoutError' });

    // When the relay's whole budget and the delivery grace pass
    await timers.advance(TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE);

    // Then
    await settled;
    expect(logs.map(line => line.args?.[0])).toEqual(['[dot.li sandbox] bitswap bridge abort postMessage failed:']);
    expect(sentry.counted('sandbox.bitswap_abort')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a sandbox user, I get a reply after my request timed out and it is ignored while a later request is still answered', async () => {
    // Given a block request that timed out
    const timers = createManualTimers();
    const sandbox = createHarness({ timers });
    const pending = sandbox.bridge.requestBlock('bafyT');
    const settled = expect(pending).rejects.toMatchObject({ name: 'BitswapBridgeTimeoutError' });
    const id = getRequestId(sandbox.posted);
    await timers.advance(TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE);

    // When the host's answer arrives late, and a later request is answered
    sandbox.receive({ type: BLOCK_RESULT, id, ok: true, bytes: new Uint8Array([1]) }, sandbox.parent);
    const next = sandbox.bridge.requestBlock('bafyU');
    const nextId = getRequestId(sandbox.posted);
    sandbox.receive({ type: BLOCK_RESULT, id: nextId, ok: true, bytes: new Uint8Array([2]) }, sandbox.parent);

    // Then the request keeps its timeout, and the later one gets its answer
    await settled;
    await expect(next).resolves.toEqual(new Uint8Array([2]));
  });

  it('As an operator, I tear down a frame with nothing in flight and the host hears nothing', async () => {
    // Given no outstanding requests
    const sandbox = createHarness();

    // When the frame goes away
    sandbox.hidePage(false);
    await Promise.resolve();

    // Then the host is not messaged at all
    expect(sandbox.posted).toEqual([]);
  });

  it('As a sandbox that let go of its bridge, I stop hearing the host and no message listener is left', () => {
    // Given a bridge listening on the sandbox's window for the host's answers
    const target = createCountingEventTarget({ type: 'message' });
    const sandbox = createHarness({ target });

    // When the sandbox lets go of the bridge
    sandbox.bridge.dispose();

    // Then no listener for the host's answers is left
    expect(target.countListening()).toBe(0);
  });

  it('As a sandbox that let go of its bridge, I stop hearing my page hide and no pagehide listener is left', () => {
    // Given a bridge listening on the sandbox's window for the page going away
    const target = createCountingEventTarget({ type: 'pagehide' });
    const sandbox = createHarness({ target });

    // When the sandbox lets go of the bridge
    sandbox.bridge.dispose();

    // Then no listener for the page going away is left
    expect(target.countListening()).toBe(0);
  });

  it('As a sandbox that let go of its bridge while a block was on its way, I hear that read abort and the host hears the abort', async () => {
    // Given a block request the host has not answered
    const sandbox = createHarness();
    const pending = sandbox.bridge.requestBlock('bafyD');
    const id = getRequestId(sandbox.posted);
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // When the sandbox lets go of the bridge
    sandbox.bridge.dispose();

    // Then the read was aborted and the host was told which fetch to drop
    await settled;
    expect(filterPosted(sandbox.posted, BLOCK_ABORT)).toMatchObject([{ type: BLOCK_ABORT, ids: [id] }]);
  });

  it('As a sandbox that let go of its bridge while a block was on its way to a host that cannot be told to stop, I hear that read abort and the failed abort is logged and counted', async () => {
    // Given a block request the host has not answered, on a parent that refuses the abort
    const logs = recordLog({ onFinished: onTestFinished, level: 'error' });
    const sandbox = createHarness({ refuseAborts: true });
    const pending = sandbox.bridge.requestBlock('bafyD');
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // When the sandbox lets go of the bridge
    const thrown = catchError(() => {
      sandbox.bridge.dispose();
    });

    // Then the read was aborted without the dispose throwing, and the failed abort was reported
    await settled;
    expect(thrown).toBeUndefined();
    expect(logs.map(line => line.args?.[0])).toEqual(['[dot.li sandbox] bitswap bridge abort postMessage failed:']);
    expect(sentry.counted('sandbox.bitswap_abort')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a sandbox that let go of its bridge twice, I see no error and the host hears one abort', async () => {
    // Given a block request the host has not answered, on a bridge already let go of
    const target = createCountingEventTarget({ type: 'message' });
    const sandbox = createHarness({ target });
    const pending = sandbox.bridge.requestBlock('bafyD');
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    sandbox.bridge.dispose();

    // When the sandbox lets go of it again
    const thrown = catchError(() => {
      sandbox.bridge.dispose();
    });

    // Then nothing threw, no listener is left and the host heard the abort once
    await settled;
    expect(thrown).toBeUndefined();
    expect(target.countListening()).toBe(0);
    expect(filterPosted(sandbox.posted, BLOCK_ABORT)).toHaveLength(1);
  });

  it('As a sandbox that let go of its bridge, I ask it for a block and the read aborts at once while the host hears nothing', async () => {
    // Given a bridge the sandbox let go of with nothing in flight
    const sandbox = createHarness();
    sandbox.bridge.dispose();

    // When the sandbox asks it for a block
    const pending = sandbox.bridge.requestBlock('bafyD');

    // Then the read aborts without waiting on the host, and the host was not messaged at all
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sandbox.posted).toEqual([]);
  });

  it('As a sandbox that let go of its bridge, I hear a late answer from the host and nothing changes', async () => {
    // Given a block request aborted by letting go of the bridge
    const sandbox = createHarness();
    const pending = sandbox.bridge.requestBlock('bafyD');
    const id = getRequestId(sandbox.posted);
    const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    sandbox.bridge.dispose();

    // When the host's answer and the page going away both arrive afterwards
    sandbox.receive({ type: BLOCK_RESULT, id, ok: true, bytes: new Uint8Array([1]) }, sandbox.parent);
    sandbox.hidePage(false);

    // Then the read keeps its abort and the host heard no second abort
    await settled;
    expect(filterPosted(sandbox.posted, BLOCK_ABORT)).toHaveLength(1);
  });
});

describe('createHostOriginRule', () => {
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
  ])("As the sandbox's integrator, I check %s against the host rule and it is trusted: %s", (origin, expected) => {
    // Given
    const isHostOrigin = createHostOriginRule('dot.li');

    // When
    const trusted = isHostOrigin(origin);

    // Then
    expect(trusted).toBe(expected);
  });
});
