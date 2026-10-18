// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { codec, none } from '../codec.js';
import { err, ok } from '../result.js';
import { defineSchema, request, subscription } from '../schema.js';
import { encodeMessage, type Refusal } from '../wire.js';
import { describeMessage } from './index.js';

const text = codec<string>(
  value => new TextEncoder().encode(value),
  bytes => new TextDecoder().decode(bytes),
);

const schema = defineSchema({
  version: 2,
  hello: text,
  traits: {
    notes: {
      read: request({ request: text, response: text }),
      watch: subscription({ start: none, receive: text }),
    },
  },
});

describe('describeMessage', () => {
  it('As a test, I describe a recorded message and get its trait, method, leg, id and decoded body', () => {
    // Given
    const messages = [
      encodeMessage(schema, { kind: 'method', trait: 0, method: 0, leg: 'request', id: 1, payload: 'a note' }),
      encodeMessage(schema, { kind: 'method', trait: 0, method: 0, leg: 'response', id: 1, outcome: ok('a body') }),
      encodeMessage(schema, { kind: 'method', trait: 0, method: 1, leg: 'stop', id: 2 }),
    ];

    // When
    const described = messages.map(data => describeMessage(schema, data));

    // Then
    expect(described).toEqual([
      { trait: 'notes', method: 'read', leg: 'request', id: 1, body: 'a note' },
      { trait: 'notes', method: 'read', leg: 'response', id: 1, body: { ok: true, value: 'a body' } },
      { trait: 'notes', method: 'watch', leg: 'stop', id: 2, body: undefined },
    ]);
  });

  it('As a test, I describe the library messages on the reserved trait and get their numeric ids', () => {
    // Given
    const messages = [
      encodeMessage(schema, { kind: 'handshake', leg: 'request', id: 3, version: 2, hello: 'opener' }),
      encodeMessage(schema, { kind: 'handshake', leg: 'response', id: 3, outcome: err({ version: 5 }) }),
      encodeMessage(schema, { kind: 'protocolError', id: 4, unsupportedMessage: { trait: 9, method: 1 } }),
    ];

    // When
    const described = messages.map(data => describeMessage(schema, data));

    // Then
    expect(described).toEqual([
      { trait: '255', method: '0', leg: 'request', id: 3, body: { version: 2, hello: 'opener' } },
      { trait: '255', method: '0', leg: 'response', id: 3, body: { ok: false, error: { version: 5 } } },
      { trait: '255', method: '255', leg: 'response', id: 4, body: { trait: 9, method: 1 } },
    ]);
  });

  it('As a test, I describe a message for an address the schema lacks and get its numeric ids and raw body', () => {
    // Given
    const data = Uint8Array.of(5, 0, 0, 0, 9, 1, 2, 0xde, 0xad).buffer;

    // When
    const described = describeMessage(schema, data);

    // Then
    expect(described).toEqual({ trait: '9', method: '1', leg: 'start', id: 5, body: Uint8Array.of(0xde, 0xad) });
  });

  it('As a test, I describe recorded data that is no message and am told why, with the refusal as the cause', () => {
    // Given
    const data = Uint8Array.of(1, 0, 0).buffer;

    // When
    let thrown: unknown;
    try {
      describeMessage(schema, data);
    } catch (error) {
      thrown = error;
    }

    // Then
    expect(thrown).toBeInstanceOf(Error);
    const refusal = (thrown as Error).cause as Refusal;
    expect(refusal.refused).toBe('malformed');
    expect(refusal.cause).toBeInstanceOf(RangeError);
  });
});
