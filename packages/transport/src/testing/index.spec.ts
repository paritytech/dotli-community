// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { codec, none } from '../codec.js';
import { err, ok } from '../result.js';
import { defineSchema, request, subscription, wireOf } from '../schema.js';
import { LIBRARY_TRAIT } from '../wire.js';
import { MessageRefusedError, describeMessage } from './index.js';

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

const wire = wireOf(schema);
const handshake = { trait: LIBRARY_TRAIT, method: 'handshake' } as const;

describe('describeMessage', () => {
  it('As a test, I describe a recorded message and get its trait, method, leg, id and decoded body', () => {
    // Given
    const messages = [
      wire.encode({ trait: 'notes', method: 'read', leg: 'request', id: 1, value: 'a note' }),
      wire.encode({ trait: 'notes', method: 'read', leg: 'response', id: 1, value: ok('a body') }),
      wire.encode({ trait: 'notes', method: 'watch', leg: 'stop', id: 2, value: undefined }),
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

  it('As a test, I describe the library messages and get them on the library trait by name', () => {
    // Given
    const mismatch = { tag: 'VersionMismatch', value: { version: 5 } };
    const unsupported = { tag: 'UnsupportedMessage', value: { trait: 9, method: 1 } };
    const messages = [
      wire.encode({ ...handshake, leg: 'request', id: 3, value: { version: 2, hello: 'opener' } }),
      wire.encode({ ...handshake, leg: 'response', id: 3, value: err(mismatch) }),
      wire.encode({ trait: LIBRARY_TRAIT, method: 'protocolError', leg: 'response', id: 4, value: unsupported }),
    ];

    // When
    const described = messages.map(data => describeMessage(schema, data));

    // Then
    expect(described).toEqual([
      { ...handshake, leg: 'request', id: 3, body: { version: 2, hello: 'opener' } },
      { ...handshake, leg: 'response', id: 3, body: err(mismatch) },
      { trait: LIBRARY_TRAIT, method: 'protocolError', leg: 'response', id: 4, body: unsupported },
    ]);
  });

  it('As a test, I describe a message for an address the schema lacks and get its numeric ids', () => {
    // Given
    const data = Uint8Array.of(5, 0, 0, 0, 9, 1, 2, 0xde, 0xad).buffer;

    // When
    const described = describeMessage(schema, data);

    // Then
    expect(described).toEqual({ trait: '9', method: '1', leg: 'start', id: 5, body: undefined });
  });

  it('As a test, I describe recorded data that is no message and am told why, as a refusal I can tell apart', () => {
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
    expect(thrown).toBeInstanceOf(MessageRefusedError);
    const refused = thrown as MessageRefusedError;
    expect(refused.reason).toBe('malformed');
    expect(refused.message).toBe('The data is refused as malformed');
    expect(refused.cause).toBeInstanceOf(RangeError);
  });
});
