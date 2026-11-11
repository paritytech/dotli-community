// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { catchRejection, createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import { ok } from '@dotli/transport';
import { PROTOCOL_ERRORS } from './errors.js';
import { createRemoteResolve } from './createRemoteResolve.js';
import { createFrameRpc } from './createFrameRpc.js';
import { createFakeFrame } from './createProtocolFrame.fake.js';
import { protocolSchema, type ProtocolHandler, type ProtocolTransport } from './schema.js';

const { dotName } = protocolSchema.sections.resolve;

/** A frame app that resolves names with `handler`. */
function createResolvingFrame(handler: ProtocolHandler<typeof dotName>): (serving: ProtocolTransport) => void {
  return serving => {
    serving.handleSubscription(dotName, handler);
  };
}

describe('createRemoteResolve', () => {
  let timers: ManualTimers;

  function createResolve(serve: (serving: ProtocolTransport) => void) {
    const fake = createFakeFrame({ serve, timers });
    return createRemoteResolve({ rpc: createFrameRpc({ frame: fake.frame, timers }) });
  }

  beforeEach(() => {
    timers = createManualTimers();
  });

  it('As the host, I hear each phase, then the resolved name', async () => {
    // Given
    const asked: string[] = [];
    const resolve = createResolve(
      createResolvingFrame(({ label }, _context, sink) => {
        asked.push(label);
        sink.send({ tag: 'phase', value: 'asset-hub-syncing' });
        sink.send({ tag: 'phase', value: 'resolving-content' });
        sink.send({ tag: 'resolved', value: '0xcid' });
        sink.interrupt(ok());
        return () => undefined;
      }),
    );
    const phases: string[] = [];

    // When
    const cid = resolve.resolveDotName('doom', phase => phases.push(phase));
    await timers.advance(0);

    // Then
    await expect(cid).resolves.toBe('0xcid');
    expect(asked).toEqual(['doom']);
    expect(phases).toEqual(['asset-hub-syncing', 'resolving-content']);
  });

  it('As the host, I stop a resolution in the frame once I have its result, even if the frame does not end it', async () => {
    // Given a frame app that sends the result and leaves the subscription open
    let stopped = false;
    const resolve = createResolve(
      createResolvingFrame((_payload, _context, sink) => {
        sink.send({ tag: 'resolved', value: '0xcid' });
        return () => {
          stopped = true;
        };
      }),
    );

    // When
    const cid = resolve.resolveDotName('doom');
    await timers.advance(0);

    // Then
    await expect(cid).resolves.toBe('0xcid');
    expect(stopped).toBe(true);
  });

  it('As the host, I resolve a name the frame ends before its result and the resolution rejects', async () => {
    // Given a frame app that stops after a phase
    const resolve = createResolve(
      createResolvingFrame((_payload, _context, sink) => {
        sink.send({ tag: 'phase', value: 'asset-hub-syncing' });
        sink.interrupt(ok());
        return () => undefined;
      }),
    );

    // When
    const cid = catchRejection(resolve.resolveDotName('doom'));
    await timers.advance(0);

    // Then
    expect((await cid).message).toBe(PROTOCOL_ERRORS.RESOLUTION_ENDED);
  });

  it('As the host, I see a resolution that outlives its budget stopped in the frame and failed as timed out', async () => {
    // Given a frame app that never answers
    let stopped = false;
    const resolve = createResolve(
      createResolvingFrame(() => () => {
        stopped = true;
      }),
    );
    const cid = catchRejection(resolve.resolveDotName('doom'));
    await timers.advance(0);

    // When
    await timers.advance(89_999);
    const stoppedBeforeBudget = stopped;
    await timers.advance(1);

    // Then
    expect(stoppedBeforeBudget).toBe(false);
    expect((await cid).name).toBe('ProtocolTimeoutError');
    expect(stopped).toBe(true);
  });
});
