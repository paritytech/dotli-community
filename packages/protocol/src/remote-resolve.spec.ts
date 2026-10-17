// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { manualTimers, type ManualTimers } from '@dotli/shared/testing';
import { PROTOCOL_ERRORS } from './errors.js';
import { createRemoteResolve } from './remote-resolve.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame } from './frame.fake.js';
import type { ServingTransport, SubscriptionHandler } from './transport-serving.js';

/** A frame app that resolves names with `handler`. */
function resolving(handler: SubscriptionHandler<'resolveDotName'>): (serving: ServingTransport) => void {
  return serving => {
    serving.handleSubscription('resolveDotName', handler);
  };
}

describe('createRemoteResolve', () => {
  let timers: ManualTimers;

  function resolveOver(serve: (serving: ServingTransport) => void) {
    const fake = createFakeFrame(serve, { timers });
    return createRemoteResolve({ frame: fake.frame, rpc: createFrameRpc(fake.frame, timers), timers });
  }

  beforeEach(() => {
    timers = manualTimers();
  });

  it('As the host, I hear each phase, then the resolved name', async () => {
    // Given
    const asked: string[] = [];
    const resolve = resolveOver(
      resolving(({ label }, _context, sink) => {
        asked.push(label);
        sink.send({ tag: 'phase', value: 'asset-hub-syncing' });
        sink.send({ tag: 'phase', value: 'resolving-content' });
        sink.send({ tag: 'resolved', value: '0xcid' });
        sink.end();
        return () => undefined;
      }),
    );
    const phases: string[] = [];

    // When
    const cid = resolve.resolveDotNameRemote('doom', phase => phases.push(phase));
    await timers.advance(0);

    // Then
    await expect(cid).resolves.toBe('0xcid');
    expect(asked).toEqual(['doom']);
    expect(phases).toEqual(['asset-hub-syncing', 'resolving-content']);
  });

  it('As the host, a resolution that ends before its result rejects', async () => {
    // Given a frame app that stops after a phase
    const resolve = resolveOver(
      resolving((_payload, _context, sink) => {
        sink.send({ tag: 'phase', value: 'asset-hub-syncing' });
        sink.end();
        return () => undefined;
      }),
    );

    // When
    const cid = resolve.resolveDotNameRemote('doom').then(
      () => new Error('the resolution succeeded'),
      (err: unknown) => err as Error,
    );
    await timers.advance(0);

    // Then
    expect((await cid).message).toBe(PROTOCOL_ERRORS.RESOLUTION_ENDED);
  });

  it('As the host, a resolution that outlives its budget is stopped in the frame and fails as timed out', async () => {
    // Given a frame app that never answers
    let stopped = false;
    const resolve = resolveOver(
      resolving(() => () => {
        stopped = true;
      }),
    );
    const cid = resolve.resolveDotNameRemote('doom').then(
      () => new Error('the resolution succeeded'),
      (err: unknown) => err as Error,
    );
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
