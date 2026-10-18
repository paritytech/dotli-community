// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createTransport, ok } from '@dotli/transport';
import { createProviderPair } from '@dotli/transport/testing';
import { protocolSchema, type ProtocolTransport } from '../schema.js';
import { describeWireMessage } from './index.js';

/** The host and a frame app over one in-memory channel, with every message either side received. */
function wire(): { host: ProtocolTransport; frame: ProtocolTransport; delivered: ArrayBuffer[] } {
  const { left, right, delivered } = createProviderPair();
  const hello = { resolutionId: null };
  const frame = createTransport(protocolSchema, right, { handshake: 'accept', hello });
  const host = createTransport(protocolSchema, left, { handshake: 'open', hello });
  host.connect();
  return { host, frame, delivered };
}

describe('describeWireMessage', () => {
  it('As a test, I describe a recorded wire message as its trait, method, leg and body', async () => {
    // Given a frame app that reports one telemetry event to the host
    const { host, frame, delivered } = wire();
    frame.handleSubscription('frame', 'telemetry', (_start, _context, sink) => {
      sink.receive({ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } });
      return () => undefined;
    });
    await new Promise<void>(resolve => {
      host.subscribe('frame', 'telemetry', undefined, {
        receive: () => {
          resolve();
        },
        interrupt: () => undefined,
      });
    });

    // When
    const described = delivered.map(describeWireMessage).filter(message => message?.leg === 'receive');

    // Then
    expect(described).toEqual([
      {
        trait: 'frame',
        method: 'telemetry',
        leg: 'receive',
        id: expect.any(Number) as number,
        body: { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } },
      },
    ]);
  });

  it('As a test, I get null for data that is no wire message', () => {
    // Given an object, as a page of an earlier release posts, and bytes too short to hold a message
    const data = [{ namespace: 'dotli:protocol', kind: 'ready' }, new Uint8Array([1, 2]).buffer];

    // When
    const described = data.map(describeWireMessage);

    // Then
    expect(described).toEqual([null, null]);
  });

  it('As a test, I read the bytes in a recorded wire message as hex, so the record stays plain JSON', async () => {
    // Given a frame app that saves the host's wallet
    const { host, frame, delivered } = wire();
    frame.handleRequest('wallet', 'save', () => ok());
    await host.request('wallet', 'save', { siteId: 's', entropy: new Uint8Array([1, 2, 255]) });

    // When
    const described = delivered.map(describeWireMessage).find(message => message?.trait === 'wallet');

    // Then
    expect(described).toMatchObject({ trait: 'wallet', method: 'save', body: { siteId: 's', entropy: '0x0102ff' } });
  });
});
