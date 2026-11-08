// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { protocolSchema } from '@dotli/protocol';
import { err, ok, unsupported } from '@dotli/transport';
import { servePoolControl } from './servePoolControl.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

/** A control that records each call it hears. */
function createFakeControl() {
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
  it("As a frame or a worker port, I pause and resume my control on the host's word", async () => {
    // Given a control whose pause is served to a host
    const { serving, host } = linkHost();
    const control = createFakeControl();
    servePoolControl({ serving, control });

    // When the host pauses the frame and then resumes it
    const paused = await host.request(frame.pause, { paused: true });
    const resumed = await host.request(frame.pause, { paused: false });

    // Then the control paused and resumed, and each call was answered
    expect(control.calls).toEqual(['pause', 'resume']);
    expect([paused, resumed]).toEqual([ok(), ok()]);
  });

  it('As a frame or a worker port that stopped serving the pause, my control hears nothing more', async () => {
    // Given a pause served to a host
    const { serving, host } = linkHost();
    const control = createFakeControl();
    const stop = servePoolControl({ serving, control });

    // When the frame stops serving it and the host pauses it anyway
    stop();
    const refused = await host.request(frame.pause, { paused: true });

    // Then the host is refused and the control heard nothing
    expect(refused).toEqual(err(unsupported()));
    expect(control.calls).toEqual([]);
  });
});
