// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { _void, str } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { defineSchema } from '../defineSchema.js';
import { unsupported } from '../failure.js';
import { frameCodec } from '../frame.js';
import { toMessageBytes } from '../messageBytes.js';
import { request } from '../request.js';
import { err } from '../result.js';
import { subscription } from '../subscription.js';
import { FrameRefusedError } from './frameRefusedError.js';
import { matchFields, matchInstance, matchStringContaining } from './matchers.js';
import { readFrame } from './readFrame.js';

const schema = defineSchema({
  version: 2,
  hello: str,
  sections: {
    notes: {
      read: request({ request: str, response: str }),
      watch: subscription({ start: _void, receive: str }),
    },
  },
});
const { read, watch } = schema.sections.notes;

describe('readFrame', () => {
  it("As a test, I read a recorded call by its method's names and decoded message, and decode it typed with the method", () => {
    // Given
    const data = [
      read.frame.enc({
        id: 1,
        body: { tag: 'call', value: { sectionId: 0, methodId: 0, message: { tag: 'request', value: 'a note' } } },
      }),
      watch.frame.enc({
        id: 2,
        body: { tag: 'call', value: { sectionId: 0, methodId: 1, message: { tag: 'stop', value: undefined } } },
      }),
    ];

    // When
    const recorded = data.map(bytes => readFrame(schema, bytes));

    // Then
    expect(recorded).toEqual([
      {
        id: 1,
        kind: 'call',
        section: 'notes',
        method: 'read',
        message: matchInstance(Uint8Array),
        decoded: { tag: 'request', value: 'a note' },
      },
      {
        id: 2,
        kind: 'call',
        section: 'notes',
        method: 'watch',
        message: matchInstance(Uint8Array),
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
      frameCodec.enc({
        id: 3,
        body: { tag: 'handshakeOffer', value: { versions: { wire: 1, schema: 2 }, hello: str.enc('opener') } },
      }),
      frameCodec.enc({ id: 3, body: { tag: 'handshakeResponse', value: err({ wire: 1, schema: 5 }) } }),
      frameCodec.enc({ id: 4, body: { tag: 'failed', value: unsupported() } }),
    ];

    // When
    const recorded = data.map(bytes => readFrame(schema, bytes));

    // Then
    expect(recorded).toEqual([
      { id: 3, kind: 'handshakeOffer', value: { versions: { wire: 1, schema: 2 }, hello: str.enc('opener') } },
      { id: 3, kind: 'handshakeResponse', value: err({ wire: 1, schema: 5 }) },
      { id: 4, kind: 'failed', value: unsupported() },
    ]);
  });

  it('As a test, I read a call to a method the schema lacks and get its numeric ids with no decoded message', () => {
    // Given
    const data = frameCodec.enc({
      id: 5,
      body: { tag: 'call', value: { sectionId: 9, methodId: 1, message: toMessageBytes(Uint8Array.of(2, 0xde)) } },
    });

    // When
    const recorded = readFrame(schema, data);

    // Then
    expect(recorded).toEqual({
      id: 5,
      kind: 'call',
      section: '9',
      method: '1',
      message: Uint8Array.of(2, 0xde),
      decoded: null,
    });
  });

  it('As a test, I read recorded data that is no frame and am told why, as a refusal I can tell apart', () => {
    // Given
    const data = Uint8Array.of(1, 0, 0);

    // When
    const thrown = catchError(() => readFrame(schema, data));

    // Then
    expect(thrown).toEqual(matchInstance(FrameRefusedError));
    expect(thrown).toEqual(matchFields<Error>({ message: matchStringContaining('The data is no frame') }));
  });
});
