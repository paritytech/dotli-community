// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { _void } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { codec } from '../codec.js';
import { err, ok, unsupported } from '../result.js';
import { defineSchema, request, subscription } from '../schema.js';
import { encodeFrame, frame } from '../wire.js';
import { FrameRefusedError, readFrame, readMessage } from './index.js';

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
      watch: subscription({ start: _void, receive: text }),
    },
  },
});
const { read, watch } = schema.traits.notes;

describe('readFrame', () => {
  it("As a test, I read a recorded call by its method's names and tag, and decode its message with the method", () => {
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
        tag: 'request',
        message: expect.any(Uint8Array) as Uint8Array,
      },
      {
        id: 2,
        kind: 'call',
        trait: 'notes',
        method: 'watch',
        tag: 'stop',
        message: expect.any(Uint8Array) as Uint8Array,
      },
    ]);
    const [first] = recorded;
    expect(first?.kind === 'call' ? readMessage(read, first.message) : null).toEqual({
      tag: 'request',
      value: 'a note',
    });
  });

  it("As a test, I read the library's own frames as they are", () => {
    // Given
    const data = [
      encodeFrame(frame, { id: 3, body: { tag: 'open', value: { version: 2, hello: text.enc('opener') } } }),
      encodeFrame(frame, { id: 3, body: { tag: 'accept', value: err({ version: 5 }) } }),
      encodeFrame(frame, { id: 4, body: { tag: 'failed', value: unsupported() } }),
    ];

    // When
    const recorded = data.map(bytes => readFrame(schema, bytes));

    // Then
    expect(recorded).toEqual([
      { id: 3, kind: 'open', value: { version: 2, hello: text.enc('opener') } },
      { id: 3, kind: 'accept', value: err({ version: 5 }) },
      { id: 4, kind: 'failed', value: unsupported() },
    ]);
    expect(ok(1)).toEqual({ tag: 'Ok', value: 1 });
  });

  it('As a test, I read a call to a method the schema lacks and get its numeric ids with no tag', () => {
    // Given
    const data = Uint8Array.of(5, 0, 0, 0, 3, 9, 1, 2, 0xde).buffer;

    // When
    const recorded = readFrame(schema, data);

    // Then
    expect(recorded).toEqual({
      id: 5,
      kind: 'call',
      trait: '9',
      method: '1',
      tag: null,
      message: Uint8Array.of(2, 0xde),
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
