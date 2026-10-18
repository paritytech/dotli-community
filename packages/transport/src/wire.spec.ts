// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { codec, none } from './codec.js';
import { cancelled, denied, domain, err, hostFailure, malformedFrame, ok, unsupported } from './result.js';
import { defineSchema, request, subscription, wireOf } from './schema.js';
import { LIBRARY_TRAIT, type Message } from './wire.js';

const text = codec<string>(
  value => new TextEncoder().encode(value),
  bytes => new TextDecoder().decode(bytes),
);

const byte = codec<number>(
  value => Uint8Array.of(value),
  bytes => {
    if (bytes.length !== 1) {
      throw new RangeError(`expected one byte, got ${String(bytes.length)}`);
    }
    return bytes[0] ?? 0;
  },
);

const failure = new Error('this payload never decodes');
const unreadable = codec<string>(
  value => new TextEncoder().encode(value),
  () => {
    throw failure;
  },
);

const wire = wireOf(
  defineSchema({
    version: 3,
    hello: text,
    traits: {
      notes: {
        read: request({ request: text, response: text, error: byte }),
        watch: subscription({ start: text, receive: byte, interrupt: text }),
        touch: request({ request: none, response: none }),
        broken: request({ request: unreadable, response: none }),
      },
    },
  }),
);

// notes is trait 0, and its methods are 0 to 3 in the order written.
const NOTES = 0;
const READ = 0;
const WATCH = 1;
const BROKEN = 3;

const read = { trait: 'notes', method: 'read' } as const;
const watch = { trait: 'notes', method: 'watch' } as const;
const handshake = { trait: LIBRARY_TRAIT, method: 'handshake' } as const;
const protocolError = { trait: LIBRARY_TRAIT, method: 'protocolError', leg: 'response' } as const;

const bytes = (...values: number[]): ArrayBuffer => Uint8Array.of(...values).buffer;
const listed = (data: ArrayBuffer): number[] => [...new Uint8Array(data)];

describe('wire', () => {
  it('As a transport, I encode every leg and every CallError variant and decode the same message back', () => {
    // Given
    const messages: Message[] = [
      { ...read, leg: 'request', id: 1, value: 'the first note' },
      { ...read, leg: 'response', id: 1, value: ok('a body') },
      { ...read, leg: 'response', id: 2, value: err(domain(7)) },
      { ...read, leg: 'response', id: 3, value: err(denied()) },
      { ...read, leg: 'response', id: 4, value: err(unsupported()) },
      { ...read, leg: 'response', id: 5, value: err(malformedFrame('a short payload')) },
      { ...read, leg: 'response', id: 6, value: err(hostFailure('TypeError: no such note')) },
      { ...read, leg: 'response', id: 7, value: err(cancelled()) },
      { ...watch, leg: 'start', id: 8, value: 'from the top' },
      { ...watch, leg: 'receive', id: 8, value: 42 },
      { ...watch, leg: 'interrupt', id: 8, value: ok() },
      { ...watch, leg: 'interrupt', id: 9, value: err(domain('gone')) },
      { ...watch, leg: 'interrupt', id: 10, value: err(hostFailure('Error: ü'.repeat(40))) },
      { ...watch, leg: 'stop', id: 11, value: undefined },
      { trait: 'notes', method: 'touch', leg: 'request', id: 0xffff_ffff, value: undefined },
      { ...handshake, leg: 'request', id: 12, value: { version: 3, hello: 'opener' } },
      { ...handshake, leg: 'response', id: 12, value: ok('accepter') },
      { ...handshake, leg: 'response', id: 13, value: err({ tag: 'VersionMismatch', value: { version: 9 } }) },
      { ...protocolError, id: 14, value: { tag: 'UnsupportedMessage', value: { trait: 4, method: 200 } } },
    ];

    // When
    const received = messages.map(message => wire.decode(wire.encode(message)));

    // Then
    expect(received).toEqual(messages.map(message => ({ kind: 'message', message })));
  });

  it('As a peer of any release, I encode the handshake and the protocol error and get the frozen bytes', () => {
    // Given
    const messages: Message[] = [
      { ...handshake, leg: 'request', id: 1, value: { version: 3, hello: 'hi' } },
      { ...handshake, leg: 'response', id: 2, value: ok('hi') },
      { ...handshake, leg: 'response', id: 2, value: err({ tag: 'VersionMismatch', value: { version: 3 } }) },
      { ...protocolError, id: 0x0102_0304, value: { tag: 'UnsupportedMessage', value: { trait: 7, method: 2 } } },
    ];

    // When
    const encoded = messages.map(message => listed(wire.encode(message)));

    // Then
    expect(encoded).toEqual([
      [1, 0, 0, 0, 255, 0, 0, 3, 0x68, 0x69],
      [2, 0, 0, 0, 255, 0, 1, 0, 0x68, 0x69],
      [2, 0, 0, 0, 255, 0, 1, 1, 0, 3],
      [4, 3, 2, 1, 255, 255, 1, 0, 7, 2],
    ]);
  });

  it('As a schema author, my decode gets exactly the payload bytes after the address', () => {
    // Given
    const seen: number[][] = [];
    const recording = codec<string>(
      value => new TextEncoder().encode(value),
      payload => {
        seen.push([...payload]);
        return 'seen';
      },
    );
    const recorder = wireOf(
      defineSchema({ version: 1, traits: { notes: { read: request({ request: recording, response: none }) } } }),
    );

    // When
    const received = recorder.decode(bytes(1, 0, 0, 0, NOTES, READ, 0, 0x61, 0x62));

    // Then
    expect(received).toEqual({ kind: 'message', message: { ...read, leg: 'request', id: 1, value: 'seen' } });
    expect(seen).toEqual([[0x61, 0x62]]);
  });

  it('As an accepter, I decode a handshake from another release and get its version without its hello', () => {
    // Given
    const newer = wireOf(defineSchema({ version: 4, hello: byte, traits: {} }));
    const data = newer.encode({ ...handshake, leg: 'request', id: 5, value: { version: 4, hello: 200 } });

    // When
    const received = wire.decode(data);

    // Then
    expect(received).toEqual({
      kind: 'message',
      message: { ...handshake, leg: 'request', id: 5, value: { version: 4, hello: undefined } },
    });
  });

  it('As a transport, I decode a message for an address my schema lacks and get its ids to reply to', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, 4, 0, 0, 0xaa),
      bytes(2, 0, 0, 0, NOTES, 9, 2),
      bytes(3, 0, 0, 0, 255, 7, 1, 0),
    ];

    // When
    const received = messages.map(data => wire.decode(data));

    // Then
    expect(received).toEqual([
      { kind: 'unknownAddress', id: 1, leg: 'request', trait: 4, method: 0 },
      { kind: 'unknownAddress', id: 2, leg: 'start', trait: NOTES, method: 9 },
      { kind: 'unknownAddress', id: 3, leg: 'response', trait: 255, method: 7 },
    ]);
  });

  it('As a transport, I decode data whose address cannot be read and refuse it as malformed with no header', () => {
    // Given
    const messages = [bytes(), bytes(1, 0, 0), bytes(1, 0, 0, 0, NOTES, READ), bytes(1, 0, 0, 0, NOTES, READ, 6)];

    // When
    const received = messages.map(data => wire.decode(data));

    // Then
    for (const refusal of received) {
      expect(refusal).toEqual({ kind: 'refused', reason: 'malformed', cause: expect.any(Error) as Error });
    }
  });

  it('As a serving side, I decode a leg its method does not have and refuse it as invalid with its header', () => {
    // Given
    const data = bytes(4, 0, 0, 0, NOTES, READ, 2, 0x61);

    // When
    const received = wire.decode(data);

    // Then
    expect(received).toEqual({
      kind: 'refused',
      reason: 'invalid',
      cause: new TypeError('notes.read has no start leg'),
      header: { ...read, leg: 'start', id: 4 },
    });
  });

  it('As a transport, I decode a body the codecs refuse and refuse it as malformed with its header and cause', () => {
    // Given
    const messages = [
      // An outcome tag other than Ok or Err.
      bytes(1, 0, 0, 0, NOTES, READ, 1, 2),
      // A CallError tag the wire does not define.
      bytes(2, 0, 0, 0, NOTES, READ, 1, 1, 6),
      // A reason cut short.
      bytes(3, 0, 0, 0, NOTES, READ, 1, 1, 3, 8, 0x61),
      // A byte after an interrupt that has ended.
      bytes(4, 0, 0, 0, NOTES, WATCH, 4, 0, 0xff),
      // A domain error the byte codec refuses.
      bytes(5, 0, 0, 0, NOTES, READ, 1, 1, 0, 1, 2),
    ];

    // When
    const received = messages.map(data => wire.decode(data));

    // Then
    expect(received).toEqual([
      {
        kind: 'refused',
        reason: 'malformed',
        cause: expect.any(TypeError) as TypeError,
        header: { ...read, leg: 'response', id: 1 },
      },
      {
        kind: 'refused',
        reason: 'malformed',
        cause: expect.any(TypeError) as TypeError,
        header: { ...read, leg: 'response', id: 2 },
      },
      {
        kind: 'refused',
        reason: 'malformed',
        cause: expect.any(Error) as Error,
        header: { ...read, leg: 'response', id: 3 },
      },
      {
        kind: 'refused',
        reason: 'malformed',
        cause: new RangeError('1 bytes follow the end of the message'),
        header: { ...watch, leg: 'interrupt', id: 4 },
      },
      {
        kind: 'refused',
        reason: 'malformed',
        cause: new RangeError('expected one byte, got 2'),
        header: { ...read, leg: 'response', id: 5 },
      },
    ]);
  });

  it('As a serving side, I decode a payload my decode throws on and the refusal carries its own error', () => {
    // Given
    const data = bytes(6, 0, 0, 0, NOTES, BROKEN, 0, 0x61);

    // When
    const received = wire.decode(data);

    // Then
    expect(received).toEqual({
      kind: 'refused',
      reason: 'malformed',
      cause: failure,
      header: { trait: 'notes', method: 'broken', leg: 'request', id: 6 },
    });
  });
});
