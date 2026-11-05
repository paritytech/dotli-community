// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { protocolSchema } from '@dotli/protocol';
import { err, ok, unsupported } from '@dotli/transport';
import { serveFramePause } from './serveFramePause.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

/** A pool that records each call it hears. */
function createFakePool() {
  const calls: string[] = [];
  return {
    calls,
    pause() {
      calls.push('pause');
    },
    resume() {
      calls.push('resume');
    },
  };
}

describe('serving the frame pause', () => {
  it("As a frame in direct or gateway mode, I pause and resume my pool on the host's word", async () => {
    // Given a pool whose pause is served to a host
    const { serving, host } = linkHost();
    const pool = createFakePool();
    serveFramePause({ serving, pool });

    // When the host pauses the frame and then resumes it
    const paused = await host.request(frame.pause, { paused: true });
    const resumed = await host.request(frame.pause, { paused: false });

    // Then the pool paused and resumed, and each call was answered
    expect(pool.calls).toEqual(['pause', 'resume']);
    expect([paused, resumed]).toEqual([ok(), ok()]);
  });

  it('As a frame that stopped serving the pause, my pool hears nothing more', async () => {
    // Given a pause served to a host
    const { serving, host } = linkHost();
    const pool = createFakePool();
    const stop = serveFramePause({ serving, pool });

    // When the frame stops serving it and the host pauses it anyway
    stop();
    const refused = await host.request(frame.pause, { paused: true });

    // Then the host is refused and the pool heard nothing
    expect(refused).toEqual(err(unsupported()));
    expect(pool.calls).toEqual([]);
  });
});
