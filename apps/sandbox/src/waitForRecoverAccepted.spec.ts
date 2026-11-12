// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';

import { createCountingEventTarget } from './testing/createCountingEventTarget.js';
import { waitForRecoverAccepted } from './waitForRecoverAccepted.js';

const HOST = 'https://doom.dot.li';
const ACCEPTED = { type: 'dotli:sandbox-recover-accepted' };
const DEADLINE_MS = 6_000;

/** The sandbox's window and its host parent, as fakes the spec drives. */
function createHarness() {
  const window = createCountingEventTarget({ type: 'message' });
  const parent = {};
  const timers = createManualTimers();
  return {
    window,
    parent,
    timers,
    /** Starts a wait on the harness's window and parent that only `HOST` may answer. */
    wait: () =>
      waitForRecoverAccepted({
        window,
        parent,
        isHostOrigin: origin => origin === HOST,
        ms: DEADLINE_MS,
        timers,
      }),
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
    const accepted = sandbox.wait();

    // When the host accepts the ask
    sandbox.receive(ACCEPTED, sandbox.parent);

    // Then the wait resolves and no listener is left
    await expect(accepted).resolves.toBeUndefined();
    expect(sandbox.window.countListening()).toBe(0);
  });

  it('As a reloaded sandbox, I ignore an acceptance from another window or origin', async () => {
    // Given a wait for the host's acceptance
    const sandbox = createHarness();
    const accepted = sandbox.wait();

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

  it('As a reloaded sandbox whose host never accepts, I give up at the deadline and stop listening', async () => {
    // Given a wait for the host's acceptance
    const sandbox = createHarness();
    const accepted = sandbox.wait();
    const settled = expect(accepted).rejects.toThrow('did not accept');

    // When the deadline passes with no acceptance
    await sandbox.timers.advance(DEADLINE_MS);

    // Then the wait rejects and no listener is left
    await settled;
    expect(sandbox.window.countListening()).toBe(0);
  });
});
