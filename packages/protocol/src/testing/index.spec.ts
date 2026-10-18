// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createTransport, ok } from '@dotli/transport';
import { createProviderPair } from '@dotli/transport/testing';
import { protocolSchema, type ProtocolTransport } from '../schema.js';
import { messagesOf, recordWireMessage } from './index.js';

const { frame: frameTrait, wallet } = protocolSchema.traits;

/** The host and a frame app over one in-memory channel, with every message either side received. */
function wire(): { host: ProtocolTransport; frame: ProtocolTransport; delivered: ArrayBuffer[] } {
  const { left, right, delivered } = createProviderPair();
  const hello = { resolutionId: null };
  const frame = createTransport(protocolSchema, right, { handshake: 'accept', hello });
  const host = createTransport(protocolSchema, left, { handshake: 'open', hello });
  host.connect();
  return { host, frame, delivered };
}

describe('recordWireMessage', () => {
  it("As a test, I record a call's message by its trait, method and tag, as JSON, and decode it with its method", async () => {
    // Given a frame app that reports one telemetry event to the host
    const { host, frame, delivered } = wire();
    frame.handleSubscription(frameTrait.telemetry, (_start, _context, sink) => {
      sink.receive({ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } });
      return () => undefined;
    });
    await new Promise<void>(resolve => {
      host.subscribe(frameTrait.telemetry, undefined, {
        receive: () => {
          resolve();
        },
        interrupt: () => undefined,
        close: () => undefined,
      });
    });

    // When
    const recorded = delivered.flatMap(data => recordWireMessage(data) ?? []);

    // Then
    expect(recorded.filter(message => message.tag === 'receive')).toEqual([
      {
        id: expect.any(Number) as number,
        trait: 'frame',
        method: 'telemetry',
        tag: 'receive',
        message: expect.any(String) as string,
        json: JSON.stringify({
          tag: 'receive',
          value: { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } },
        }),
      },
    ]);
    expect(messagesOf(frameTrait.telemetry, recorded)).toEqual([
      { tag: 'start', value: undefined },
      { tag: 'receive', value: { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } } },
    ]);
  });

  it("As a test, I get null for data that is no frame and for the library's own frames", async () => {
    // Given a handshake both sides heard, and bytes too short to hold a frame
    const { host, delivered } = wire();
    await host.whenConnected();
    const data = [...delivered, new Uint8Array([1, 2]).buffer];

    // When
    const recorded = data.map(recordWireMessage);

    // Then
    expect(delivered.length).toBeGreaterThan(0);
    expect(recorded).toEqual(data.map(() => null));
  });

  it('As a test, I record the bytes of a message as hex, so the record stays plain JSON and decodes back', async () => {
    // Given a frame app that saves the host's wallet
    const { host, frame, delivered } = wire();
    frame.handleRequest(wallet.save, () => ok());
    await host.request(wallet.save, { siteId: 's', entropy: new Uint8Array([1, 2, 255]) });

    // When
    const recorded = delivered.flatMap(data => recordWireMessage(data) ?? []);

    // Then
    expect(JSON.parse(JSON.stringify(recorded))).toEqual(recorded);
    expect(messagesOf(wallet.save, recorded)).toEqual([
      { tag: 'request', value: { siteId: 's', entropy: new Uint8Array([1, 2, 255]) } },
      { tag: 'response', value: ok() },
    ]);
  });
});
