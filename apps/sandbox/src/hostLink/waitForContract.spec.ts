// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';

import { createCountingEventTarget } from '../testing/createCountingEventTarget.js';
import { waitForContract } from './waitForContract.js';

const HOST = 'https://doom.dot.li';
const CONTRACT = {
  type: 'dotli:sandbox-contract',
  v: '1',
  cid: 'bafy',
  chainBackend: 'rpc-gateway',
  network: 'paseo-next-v2',
};
const DEADLINE_MS = 6_000;
const INTERVAL_MS = 250;

/** The sandbox's window and its host parent, as fakes the spec drives. */
function createHarness() {
  const window = createCountingEventTarget({ type: 'message' });
  const posts: unknown[] = [];
  const parent = {
    postMessage: (message: unknown) => {
      posts.push(message);
    },
  };
  const timers = createManualTimers();
  return {
    window,
    parent,
    posts,
    timers,
    /** Starts a wait on the harness's window and parent that only `HOST` may answer. */
    wait: () =>
      waitForContract({
        window,
        parent,
        isHostOrigin: origin => origin === HOST,
        ms: DEADLINE_MS,
        intervalMs: INTERVAL_MS,
        timers,
      }),
    /** A message arriving on the sandbox's window. */
    receive: (data: unknown, source: unknown, { origin = HOST }: { origin?: string } = {}) => {
      // Node's MessageEvent refuses a source that is not a port, so the message carries its fields by hand.
      window.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
    },
  };
}

describe('waitForContract', () => {
  it('As a sandbox at boot, I ask my host and take the contract it replies with, then stop asking', async () => {
    // Given a wait that has asked its host once
    const sandbox = createHarness();
    const contract = sandbox.wait();
    expect(sandbox.posts).toEqual([{ type: 'dotli:sandbox-contract-request' }]);

    // When the host replies with the contract
    sandbox.receive(CONTRACT, sandbox.parent);

    // Then the wait resolves with the parsed contract, leaves no listener, and asks no more
    await expect(contract).resolves.toMatchObject({ type: 'dotli:sandbox-contract', cid: 'bafy' });
    expect(sandbox.window.countListening()).toBe(0);
    await sandbox.timers.advance(INTERVAL_MS * 2);
    expect(sandbox.posts).toHaveLength(1);
  });

  it('As a sandbox whose host is not ready yet, I re-ask on an interval until the reply arrives', async () => {
    // Given a wait whose first ask went unanswered
    const sandbox = createHarness();
    const contract = sandbox.wait();

    // When the interval passes twice before the host replies
    await sandbox.timers.advance(INTERVAL_MS);
    await sandbox.timers.advance(INTERVAL_MS);
    const asksBeforeReply = sandbox.posts.length;
    sandbox.receive(CONTRACT, sandbox.parent);

    // Then the request was re-posted each interval and no further ask goes out after the reply
    expect(asksBeforeReply).toBe(3);
    await expect(contract).resolves.toMatchObject({ type: 'dotli:sandbox-contract' });
    await sandbox.timers.advance(INTERVAL_MS);
    expect(sandbox.posts).toHaveLength(3);
  });

  it('As a sandbox, I ignore a reply from another window, an untrusted origin, or a non-contract message', async () => {
    // Given a wait for the host's contract
    const sandbox = createHarness();
    const contract = sandbox.wait();

    // When a contract arrives from another window, then the parent on an untrusted origin, then a non-contract message
    sandbox.receive(CONTRACT, {});
    sandbox.receive(CONTRACT, sandbox.parent, { origin: 'https://evil.example' });
    sandbox.receive({ type: 'dotli:bitswap-result', id: 'r-1', ok: true, bytes: new Uint8Array() }, sandbox.parent);
    const listeningAfterStrays = sandbox.window.countListening();
    sandbox.receive(CONTRACT, sandbox.parent);

    // Then the wait kept listening through the strays and resolves on the host's contract
    expect(listeningAfterStrays).toBe(1);
    await expect(contract).resolves.toMatchObject({ type: 'dotli:sandbox-contract' });
    expect(sandbox.window.countListening()).toBe(0);
  });

  it('As a sandbox whose host never replies, I give up at the deadline and stop asking', async () => {
    // Given a wait for the host's contract
    const sandbox = createHarness();
    const contract = sandbox.wait();
    const settled = expect(contract).rejects.toThrow('did not deliver');

    // When the deadline passes with no reply
    await sandbox.timers.advance(DEADLINE_MS);

    // Then the wait rejects, leaves no listener, and asks no more
    await settled;
    expect(sandbox.window.countListening()).toBe(0);
    const asksAtDeadline = sandbox.posts.length;
    await sandbox.timers.advance(INTERVAL_MS * 2);
    expect(sandbox.posts).toHaveLength(asksAtDeadline);
  });
});
