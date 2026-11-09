// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createCountingEventTarget } from './testing/createCountingEventTarget.js';
import { waitForRecoverAccepted } from './waitForRecoverAccepted.js';

const HOST = 'https://doom.dot.li';
const ACCEPTED = { type: 'dotli:sandbox-recover-accepted' };

/** The sandbox's window and its host parent, as fakes the spec drives. */
function createHarness() {
  const window = createCountingEventTarget({ type: 'message' });
  const parent = {};
  return {
    window,
    parent,
    /** Starts a wait on the harness's window and parent that only `HOST` may answer. */
    wait: (signal: AbortSignal) =>
      waitForRecoverAccepted({ window, parent, isHostOrigin: origin => origin === HOST, signal }),
    /** A message arriving on the sandbox's window. */
    receive: (data: unknown, source: unknown, { origin = HOST }: { origin?: string } = {}) => {
      // Node's MessageEvent refuses a source that is not a port, so the message carries its fields by hand.
      window.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
    },
  };
}

describe('waitForRecoverAccepted', () => {
  it('As a reloaded sandbox, I hear my host accept my recover ask and stop listening', async () => {
    // Given a wait for the host's acceptance
    const sandbox = createHarness();
    const accepted = sandbox.wait(new AbortController().signal);

    // When the host accepts the ask
    sandbox.receive(ACCEPTED, sandbox.parent);

    // Then the wait resolves and no listener is left
    await expect(accepted).resolves.toBeUndefined();
    expect(sandbox.window.countListening()).toBe(0);
  });

  it('As a reloaded sandbox, I ignore an acceptance from another window or origin', async () => {
    // Given a wait for the host's acceptance
    const sandbox = createHarness();
    const accepted = sandbox.wait(new AbortController().signal);

    // When an acceptance arrives from another window, then from the parent on an untrusted origin, then from the host
    sandbox.receive(ACCEPTED, {});
    sandbox.receive(ACCEPTED, sandbox.parent, { origin: 'https://evil.example' });
    const listeningAfterStrays = sandbox.window.countListening();
    sandbox.receive(ACCEPTED, sandbox.parent);

    // Then the wait kept listening through the strays and resolves on the host's acceptance
    expect(listeningAfterStrays).toBe(1);
    await expect(accepted).resolves.toBeUndefined();
    expect(sandbox.window.countListening()).toBe(0);
  });

  it('As a reloaded sandbox whose wait was given up, I stop listening and hear the reason', async () => {
    // Given a wait for the host's acceptance
    const sandbox = createHarness();
    const controller = new AbortController();
    const accepted = sandbox.wait(controller.signal);
    const reason = new Error('the host never accepted the recover ask');

    // When the wait is given up
    controller.abort(reason);

    // Then the wait rejects with the reason and no listener is left
    await expect(accepted).rejects.toBe(reason);
    expect(sandbox.window.countListening()).toBe(0);
  });

  it('As a reloaded sandbox whose wait was given up before it started, I hear the reason and never listen', async () => {
    // Given a signal already aborted
    const sandbox = createHarness();
    const reason = new Error('the sandbox is going away');
    const signal = AbortSignal.abort(reason);

    // When a wait starts on it
    const accepted = sandbox.wait(signal);

    // Then the wait rejects with the reason and added no listener
    await expect(accepted).rejects.toBe(reason);
    expect(sandbox.window.countListening()).toBe(0);
  });
});
