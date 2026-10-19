// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { _void, str } from 'scale-ts';
import { describe, expect, it } from 'vitest';

import { err, unsupported } from '../errors.js';
import { defineSchema, request, subscription } from '../schema.js';
import { encodeFrame, frame } from '../wire.js';
import { FrameRefusedError, readFrame, readMessage } from './index.js';

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
    expect(first?.kind === 'call' ? readMessage(read, first.message) : null).toEqual({
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
