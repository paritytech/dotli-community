// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { codec, none } from './codec.js';
import { cancelled, denied, domain, err, hostFailure, malformedFrame, ok, unsupported } from './result.js';
import { defineSchema, request, subscription } from './schema.js';
import { decodeMessage, encodeMessage, type DecodedMessage, type Refusal, type WireMessage } from './wire.js';

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

const schema = defineSchema({
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
});

// notes is trait 0, and its methods are 0 to 3 in the order written.
const NOTES = 0;
const READ = 0;
const WATCH = 1;
const TOUCH = 2;
const BROKEN = 3;

const bytes = (...values: number[]): ArrayBuffer => Uint8Array.of(...values).buffer;
const listed = (data: ArrayBuffer): number[] => [...new Uint8Array(data)];

// A refusal's cause is named by its class, which is what tells a cut-short read from a refused tag or leg.
const summarised = (decoded: DecodedMessage | Refusal): unknown =>
  'refused' in decoded
    ? { ...decoded, cause: decoded.cause instanceof Error ? decoded.cause.name : typeof decoded.cause }
    : decoded;

describe('wire messages', () => {
  it('As a transport, I encode every leg and every error that crosses the wire and decode them back unchanged', () => {
    // Given
    const at = { kind: 'method', trait: NOTES } as const;
    const messages: WireMessage[] = [
      { ...at, method: READ, leg: 'request', id: 1, payload: 'the first note' },
      { ...at, method: READ, leg: 'response', id: 1, outcome: ok('a body') },
      { ...at, method: READ, leg: 'response', id: 2, outcome: err(domain(7)) },
      { ...at, method: READ, leg: 'response', id: 3, outcome: err(denied()) },
      { ...at, method: READ, leg: 'response', id: 4, outcome: err(unsupported()) },
      { ...at, method: READ, leg: 'response', id: 5, outcome: err(malformedFrame('a short payload')) },
      { ...at, method: READ, leg: 'response', id: 6, outcome: err(hostFailure('TypeError: no such note')) },
      { ...at, method: WATCH, leg: 'start', id: 7, payload: 'from the top' },
      { ...at, method: WATCH, leg: 'receive', id: 7, payload: 42 },
      { ...at, method: WATCH, leg: 'interrupt', id: 7, outcome: ok() },
      { ...at, method: WATCH, leg: 'interrupt', id: 8, outcome: err(domain('gone')) },
      { ...at, method: WATCH, leg: 'interrupt', id: 9, outcome: err(denied()) },
      { ...at, method: WATCH, leg: 'interrupt', id: 10, outcome: err(unsupported()) },
      { ...at, method: WATCH, leg: 'interrupt', id: 11, outcome: err(malformedFrame('')) },
      { ...at, method: WATCH, leg: 'interrupt', id: 12, outcome: err(hostFailure('Error: ü'.repeat(40))) },
      { ...at, method: WATCH, leg: 'stop', id: 13 },
      { ...at, method: TOUCH, leg: 'request', id: 0xffff_ffff, payload: undefined },
      { kind: 'handshake', leg: 'request', id: 14, version: 3, hello: 'opener' },
      { kind: 'handshake', leg: 'response', id: 14, outcome: ok('accepter') },
      { kind: 'handshake', leg: 'response', id: 15, outcome: err({ version: 9 }) },
      { kind: 'protocolError', id: 16, unsupportedMessage: { trait: 4, method: 200 } },
    ];

    // When
    const decoded = messages.map(message => decodeMessage(schema, encodeMessage(schema, message)));

    // Then
    expect(decoded).toEqual(messages);
  });

  it('As a transport, I am refused when I encode Cancelled, since it never crosses the wire', () => {
    // Given
    const response: WireMessage = {
      kind: 'method',
      trait: NOTES,
      method: READ,
      leg: 'response',
      id: 1,
      outcome: err(cancelled()),
    };
    const interrupt: WireMessage = {
      kind: 'method',
      trait: NOTES,
      method: WATCH,
      leg: 'interrupt',
      id: 2,
      outcome: err(cancelled()),
    };

    // When
    const encodings = [() => encodeMessage(schema, response), () => encodeMessage(schema, interrupt)];

    // Then
    for (const encode of encodings) {
      expect(encode).toThrow(/Cancelled/);
    }
  });

  it('As a transport, I am refused when I encode what the wire cannot carry exactly', () => {
    // Given
    const attempts: WireMessage[] = [
      { kind: 'method', trait: NOTES, method: TOUCH, leg: 'request', id: 2 ** 32, payload: undefined },
      { kind: 'method', trait: NOTES, method: TOUCH, leg: 'request', id: -1, payload: undefined },
      { kind: 'method', trait: NOTES, method: 9, leg: 'request', id: 1, payload: undefined },
      { kind: 'method', trait: NOTES, method: WATCH, leg: 'request', id: 1, payload: 'a start' },
      { kind: 'method', trait: NOTES, method: TOUCH, leg: 'response', id: 1, outcome: err(domain('none declared')) },
      { kind: 'handshake', leg: 'request', id: 1, version: 256, hello: 'opener' },
      { kind: 'protocolError', id: 1, unsupportedMessage: { trait: 1.5, method: 0 } },
    ];

    // When
    const encodings = attempts.map(message => () => encodeMessage(schema, message));

    // Then
    for (const encode of encodings) {
      expect(encode).toThrow();
    }
  });

  it('As a peer of any release, I read the frozen handshake request byte for byte', () => {
    // Given
    const message: WireMessage = { kind: 'handshake', leg: 'request', id: 1, version: 3, hello: 'hi' };

    // When
    const data = encodeMessage(schema, message);

    // Then
    expect(listed(data)).toEqual([1, 0, 0, 0, 255, 0, 0, 3, 0x68, 0x69]);
  });

  it('As a peer of any release, I read the frozen handshake responses byte for byte', () => {
    // Given
    const accepted: WireMessage = { kind: 'handshake', leg: 'response', id: 2, outcome: ok('hi') };
    const mismatched: WireMessage = { kind: 'handshake', leg: 'response', id: 2, outcome: err({ version: 3 }) };

    // When
    const encoded = [encodeMessage(schema, accepted), encodeMessage(schema, mismatched)];

    // Then
    expect(encoded.map(listed)).toEqual([
      [2, 0, 0, 0, 255, 0, 1, 0, 0x68, 0x69],
      [2, 0, 0, 0, 255, 0, 1, 1, 0, 3],
    ]);
  });

  it('As a peer of any release, I read the frozen protocol error byte for byte', () => {
    // Given
    const message: WireMessage = {
      kind: 'protocolError',
      id: 0x0102_0304,
      unsupportedMessage: { trait: 7, method: 2 },
    };

    // When
    const data = encodeMessage(schema, message);

    // Then
    expect(listed(data)).toEqual([4, 3, 2, 1, 255, 255, 1, 0, 7, 2]);
  });

  it('As an accepter, I read the version of an opener on another release even when its hello does not decode', () => {
    // Given
    const newer = defineSchema({ version: 4, hello: byte, traits: {} });
    const data = encodeMessage(newer, { kind: 'handshake', leg: 'request', id: 5, version: 4, hello: 200 });

    // When
    const decoded = decodeMessage(schema, data);

    // Then
    expect(decoded).toEqual({ kind: 'handshake', leg: 'request', id: 5, version: 4, hello: undefined });
  });

  it('As a transport, I learn the address of a message for a trait or method my schema lacks, so I can reply', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, 4, 0, 0, 0xaa),
      bytes(2, 0, 0, 0, NOTES, 9, 2),
      bytes(3, 0, 0, 0, 255, 7, 1, 0),
    ];

    // When
    const decoded = messages.map(data => decodeMessage(schema, data));

    // Then
    expect(decoded).toEqual([
      { kind: 'unknownAddress', id: 1, leg: 'request', unknownAddress: { trait: 4, method: 0 } },
      { kind: 'unknownAddress', id: 2, leg: 'start', unknownAddress: { trait: NOTES, method: 9 } },
      { kind: 'unknownAddress', id: 3, leg: 'response', unknownAddress: { trait: 255, method: 7 } },
    ]);
  });

  it('As a transport, I refuse a header cut short as malformed', () => {
    // Given
    const data = bytes(1, 0, 0, 0, NOTES, READ);

    // When
    const decoded = summarised(decodeMessage(schema, data));

    // Then
    expect(decoded).toEqual({ refused: 'malformed', cause: 'RangeError' });
  });

  it('As a transport, I refuse an unknown leg byte as malformed', () => {
    // Given
    const data = bytes(1, 0, 0, 0, NOTES, READ, 6);

    // When
    const decoded = summarised(decodeMessage(schema, data));

    // Then
    expect(decoded).toEqual({ refused: 'malformed', cause: 'RangeError' });
  });

  it('As a transport, I refuse trailing bytes after a body that ends as malformed', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, NOTES, WATCH, 5, 0),
      bytes(2, 0, 0, 0, NOTES, READ, 1, 1, 1, 0),
      bytes(3, 0, 0, 0, NOTES, WATCH, 4, 0, 0),
      bytes(4, 0, 0, 0, 255, 0, 1, 1, 0, 3, 0),
      bytes(5, 0, 0, 0, 255, 255, 1, 0, 7, 2, 0),
    ];

    // When
    const decoded = messages.map(data => summarised(decodeMessage(schema, data)));

    // Then
    expect(decoded).toEqual([
      {
        refused: 'malformed',
        cause: 'RangeError',
        header: { id: 1, trait: NOTES, method: WATCH, leg: 'stop' },
      },
      {
        refused: 'malformed',
        cause: 'RangeError',
        header: { id: 2, trait: NOTES, method: READ, leg: 'response' },
      },
      {
        refused: 'malformed',
        cause: 'Error',
        header: { id: 3, trait: NOTES, method: WATCH, leg: 'interrupt' },
      },
      {
        refused: 'malformed',
        cause: 'RangeError',
        header: { id: 4, trait: 255, method: 0, leg: 'response' },
      },
      {
        refused: 'malformed',
        cause: 'RangeError',
        header: { id: 5, trait: 255, method: 255, leg: 'response' },
      },
    ]);
  });

  it('As a transport, I refuse an envelope with a tag the wire does not define as malformed', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, NOTES, READ, 1, 2),
      bytes(2, 0, 0, 0, NOTES, READ, 1, 1, 5),
      bytes(3, 0, 0, 0, NOTES, READ, 1, 1, 6),
      bytes(4, 0, 0, 0, NOTES, TOUCH, 1, 1, 0),
      bytes(5, 0, 0, 0, NOTES, READ, 1, 1, 4, 8, 0x61),
      bytes(6, 0, 0, 0, 255, 0, 1, 1, 1),
      bytes(7, 0, 0, 0, 255, 255, 1, 1, 7, 2),
    ];

    // When
    const decoded = messages.map(data => summarised(decodeMessage(schema, data)));

    // Then
    for (const result of decoded) {
      expect(result).toMatchObject({ refused: 'malformed' });
    }
  });

  it('As a serving side, I refuse a leg that does not fit its method as invalid', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, NOTES, WATCH, 0, 0x61),
      bytes(2, 0, 0, 0, NOTES, READ, 5),
      bytes(3, 0, 0, 0, 255, 0, 5),
      bytes(4, 0, 0, 0, 255, 255, 0, 0, 7, 2),
    ];

    // When
    const decoded = messages.map(data => summarised(decodeMessage(schema, data)));

    // Then
    expect(decoded).toEqual([
      {
        refused: 'invalid',
        cause: 'TypeError',
        header: { id: 1, trait: NOTES, method: WATCH, leg: 'request' },
      },
      { refused: 'invalid', cause: 'TypeError', header: { id: 2, trait: NOTES, method: READ, leg: 'stop' } },
      { refused: 'invalid', cause: 'TypeError', header: { id: 3, trait: 255, method: 0, leg: 'stop' } },
      { refused: 'invalid', cause: 'TypeError', header: { id: 4, trait: 255, method: 255, leg: 'request' } },
    ]);
  });

  it('As a serving side, I refuse a payload my decode throws on as malformed, with its cause and address', () => {
    // Given
    const data = encodeMessage(schema, {
      kind: 'method',
      trait: NOTES,
      method: BROKEN,
      leg: 'request',
      id: 21,
      payload: 'unreadable',
    });

    // When
    const decoded = decodeMessage(schema, data);

    // Then
    expect(decoded).toEqual({
      refused: 'malformed',
      cause: failure,
      header: { id: 21, trait: NOTES, method: BROKEN, leg: 'request' },
    });
  });

  it('As a schema author, my decode gets exactly the payload bytes even when the message has a header before them', () => {
    // Given
    const seen: Uint8Array[] = [];
    const spy = codec<string>(
      value => new TextEncoder().encode(value),
      payload => {
        seen.push(payload);
        return new TextDecoder().decode(payload);
      },
    );
    const spied = defineSchema({
      version: 1,
      traits: { notes: { echo: request({ request: spy, response: none }) } },
    });
    const data = encodeMessage(spied, {
      kind: 'method',
      trait: NOTES,
      method: 0,
      leg: 'request',
      id: 1,
      payload: 'abc',
    });

    // When
    const decoded = decodeMessage(spied, data);

    // Then
    expect(decoded).toMatchObject({ payload: 'abc' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.buffer).toBe(data);
    expect(seen[0]?.byteOffset).toBe(7);
    expect([...(seen[0] ?? [])]).toEqual([0x61, 0x62, 0x63]);
  });
});
