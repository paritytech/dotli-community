// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { manualTimers } from '@dotli/shared/testing';
import { ProtocolPortReleasedError } from './errors.js';
import { WIRE_VERSION } from './methods.js';
import { createProviderPair } from './provider.fake.js';
import { decodedLegs, rawPeer, rig } from './testing/transport-rig.js';
import { createConsumerTransport } from './transport-consumer.js';
import { createServingTransport } from './transport-serving.js';

describe('createServingTransport', () => {
  it('As the frame, I refuse a handshake of another wire version', async () => {
    // Given
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    createServingTransport(right, { side: 'frame', count: vi.fn() });
    const peer = rawPeer(left);

    // When
    peer.send({
      leg: 'request',
      id: 1,
      method: 'handshake',
      deadlineMs: null,
      payload: { version: WIRE_VERSION + 1, resolutionId: null },
    });
    await timers.advance(0);

    // Then
    expect(peer.heard).toHaveLength(1);
    expect(peer.heard[0]).toMatchObject({
      leg: 'response',
      id: 1,
      method: 'handshake',
      outcome: { ok: false, error: { name: 'ProtocolVersionMismatchError' } },
    });
  });

  it("As a handler, I read the caller's deadline, origin and resolution id", async () => {
    // Given
    const { consumer, serving, timers } = rig({ resolutionId: 'r1' });
    const handler = vi.fn(() => undefined);
    serving.handleRequest('heartbeat', handler);
    consumer.connect();

    // When
    const call = consumer.request('heartbeat', undefined, { deadlineMs: 1_234 });
    await timers.advance(0);
    await call;

    // Then
    expect(handler).toHaveBeenCalledExactlyOnceWith(undefined, {
      origin: null,
      deadlineMs: 1_234,
      resolutionId: 'r1',
    });
  });

  it('As the worker, disposing my serving transport ends each open subscription with the reason', async () => {
    // Given
    const { left, right, delivered } = createProviderPair();
    const timers = manualTimers();
    const serving = createServingTransport(right, { side: 'worker', count: vi.fn() });
    const consumer = createConsumerTransport(left, { side: 'frame', timers, count: vi.fn() });
    const stops = [vi.fn(), vi.fn()];
    let started = 0;
    serving.handleSubscription('chainConnect', () => {
      const stop = stops[started];
      started += 1;
      return stop ?? (() => undefined);
    });
    consumer.connect();
    const ends = [vi.fn(), vi.fn()];
    for (const [index, onEnd] of ends.entries()) {
      consumer
        .subscribe('chainConnect', { genesisHash: '0x1', connectionId: `c${String(index)}` }, () => undefined)
        .onEnd(onEnd);
    }
    await timers.advance(0);

    // When
    serving.dispose(new ProtocolPortReleasedError('the worker let this tab go'));
    await timers.advance(0);

    // Then
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledOnce();
    }
    for (const onEnd of ends) {
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onEnd.mock.calls[0]?.[0]).toMatchObject({ name: 'ProtocolPortReleasedError' });
    }
    expect(decodedLegs(delivered).filter(leg => leg === 'end:chainConnect')).toHaveLength(2);
  });
});
