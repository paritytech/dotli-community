// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, Struct, _void, str, u128 } from 'scale-ts';
import { describe, expect, it } from 'vitest';

import { err, ok, unsupported } from '../errors.js';
import { createProviderPair } from '../provider.fake.js';
import { defineSchema, request, subscription } from '../schema.js';
import { createTransport } from '../transport.js';
import { encodeFrame, frame } from '../wire.js';
import { FrameRefusedError, messagesOf, readFrame, recordMessage } from './index.js';

const schema = defineSchema({
  version: 2,
  hello: str,
  traits: {
    notes: {
      read: request({ request: str, response: str }),
      watch: subscription({ start: _void, receive: str }),
    },
  },
});
const { read, watch } = schema.traits.notes;

/** A schema whose messages carry bytes and a big integer, which JSON does not keep as they are. */
const vaultSchema = defineSchema({
  version: 1,
  hello: str,
  traits: {
    vault: {
      save: request({ request: Struct({ entropy: Bytes(), amount: u128 }), response: _void }),
      events: subscription({ start: _void, receive: str }),
    },
  },
});
const { save, events } = vaultSchema.traits.vault;

/** An opener and an accepter over one in-memory channel, with every message either side received. */
function wire() {
  const { left, right, delivered } = createProviderPair();
  const accepter = createTransport(vaultSchema, right, { handshake: 'accept', hello: 'accepter' });
  const opener = createTransport(vaultSchema, left, { handshake: 'open', hello: 'opener' });
  opener.connect();
  return { opener, accepter, delivered };
}

const record = (data: ArrayBuffer) => recordMessage(vaultSchema, data);

describe('readFrame', () => {
  it("As a test, I read a recorded call by its method's names and decoded message, and decode it typed with the method", () => {
    // Given
    const data = [
      encodeFrame(read.frame, {
        id: 1,
        body: { tag: 'call', value: { trait: 0, method: 0, message: { tag: 'request', value: 'a note' } } },
      }),
      encodeFrame(watch.frame, {
        id: 2,
        body: { tag: 'call', value: { trait: 0, method: 1, message: { tag: 'stop', value: undefined } } },
      }),
    ];

    // When
    const recorded = data.map(bytes => readFrame(schema, bytes));

    // Then
    expect(recorded).toEqual([
      {
        id: 1,
        kind: 'call',
        trait: 'notes',
        method: 'read',
        message: expect.any(Uint8Array) as Uint8Array,
        decoded: { tag: 'request', value: 'a note' },
      },
      {
        id: 2,
        kind: 'call',
        trait: 'notes',
        method: 'watch',
        message: expect.any(Uint8Array) as Uint8Array,
        decoded: { tag: 'stop', value: undefined },
      },
    ]);
    const [first] = recorded;
    expect(first?.kind === 'call' ? read.message.dec(first.message) : null).toEqual({
      tag: 'request',
      value: 'a note',
    });
  });

  it("As a test, I read the library's own frames as they are", () => {
    // Given
    const data = [
      encodeFrame(frame, { id: 3, body: { tag: 'open', value: { version: 2, hello: str.enc('opener') } } }),
      encodeFrame(frame, { id: 3, body: { tag: 'accept', value: err({ version: 5 }) } }),
      encodeFrame(frame, { id: 4, body: { tag: 'failed', value: unsupported() } }),
    ];

    // When
    const recorded = data.map(bytes => readFrame(schema, bytes));

    // Then
    expect(recorded).toEqual([
      { id: 3, kind: 'open', value: { version: 2, hello: str.enc('opener') } },
      { id: 3, kind: 'accept', value: err({ version: 5 }) },
      { id: 4, kind: 'failed', value: unsupported() },
    ]);
  });

  it('As a test, I read a call to a method the schema lacks and get its numeric ids with no decoded message', () => {
    // Given
    const data = encodeFrame(frame, {
      id: 5,
      body: { tag: 'call', value: { trait: 9, method: 1, message: Uint8Array.of(2, 0xde) } },
    });

    // When
    const recorded = readFrame(schema, data);

    // Then
    expect(recorded).toEqual({
      id: 5,
      kind: 'call',
      trait: '9',
      method: '1',
      message: Uint8Array.of(2, 0xde),
      decoded: null,
    });
  });

  it('As a test, I read recorded data that is no frame and am told why, as a refusal I can tell apart', () => {
    // Given
    const data = Uint8Array.of(1, 0, 0).buffer;

    // When
    const read = () => readFrame(schema, data);

    // Then
    expect(read).toThrow(FrameRefusedError);
    expect(read).toThrow('The data is no frame');
  });
});

describe('recordMessage', () => {
  it("As a test, I record a call's message by its trait, method and tag, as JSON, and decode it with its method", async () => {
    // Given an accepter that sends the opener one event
    const { opener, accepter, delivered } = wire();
    accepter.handleSubscription(events, (_start, _context, sink) => {
      sink.receive('synced');
      return () => undefined;
    });
    await new Promise<void>(resolve => {
      opener.subscribe(events, undefined, {
        receive: () => {
          resolve();
        },
        interrupt: () => undefined,
        close: () => undefined,
      });
    });

    // When
    const recorded = delivered.flatMap(data => record(data) ?? []);

    // Then
    expect(recorded.filter(message => message.tag === 'receive')).toEqual([
      {
        id: expect.any(Number) as number,
        trait: 'vault',
        method: 'events',
        tag: 'receive',
        message: expect.any(String) as string,
        json: JSON.stringify({ tag: 'receive', value: 'synced' }),
      },
    ]);
    expect(messagesOf(vaultSchema, events, recorded)).toEqual([
      { tag: 'start', value: undefined },
      { tag: 'receive', value: 'synced' },
    ]);
  });

  it("As a test, I get null for data that is no frame and for the library's own frames", async () => {
    // Given a handshake both sides heard, and bytes too short to hold a frame
    const { opener, delivered } = wire();
    await opener.whenConnected();
    const data = [...delivered, new Uint8Array([1, 2]).buffer];

    // When
    const recorded = data.map(record);

    // Then
    expect(delivered.length).toBeGreaterThan(0);
    expect(recorded).toEqual(data.map(() => null));
  });

  it('As a test, I record the bytes of a message as hex, so the record stays plain JSON and decodes back', async () => {
    // Given an accepter that saves what the opener sends
    const { opener, accepter, delivered } = wire();
    accepter.handleRequest(save, () => ok());
    await opener.request(save, { entropy: new Uint8Array([1, 2, 255]), amount: 2n ** 100n });

    // When
    const recorded = delivered.flatMap(data => record(data) ?? []);

    // Then
    expect(JSON.parse(JSON.stringify(recorded))).toEqual(recorded);
    expect(recorded.find(message => message.tag === 'request')?.json).toBe(
      JSON.stringify({ tag: 'request', value: { entropy: '0x0102ff', amount: (2n ** 100n).toString() } }),
    );
    expect(messagesOf(vaultSchema, save, recorded)).toEqual([
      { tag: 'request', value: { entropy: new Uint8Array([1, 2, 255]), amount: 2n ** 100n } },
      { tag: 'response', value: ok() },
    ]);
  });
});
