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
  it('As a transport, I encode every leg and every error that crosses the wire and decode the same message back', () => {
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
      { ...at, method: READ, leg: 'response', id: 7, outcome: err(hostFailure('﻿a leading mark')) },
      { ...at, method: WATCH, leg: 'start', id: 8, payload: 'from the top' },
      { ...at, method: WATCH, leg: 'receive', id: 8, payload: 42 },
      { ...at, method: WATCH, leg: 'interrupt', id: 8, outcome: ok() },
      { ...at, method: WATCH, leg: 'interrupt', id: 9, outcome: err(domain('gone')) },
      { ...at, method: WATCH, leg: 'interrupt', id: 10, outcome: err(denied()) },
      { ...at, method: WATCH, leg: 'interrupt', id: 11, outcome: err(unsupported()) },
      { ...at, method: WATCH, leg: 'interrupt', id: 12, outcome: err(malformedFrame('')) },
      { ...at, method: WATCH, leg: 'interrupt', id: 13, outcome: err(hostFailure('Error: ü'.repeat(40))) },
      { ...at, method: WATCH, leg: 'interrupt', id: 14, outcome: err(hostFailure('x'.repeat(20_000))) },
      { ...at, method: WATCH, leg: 'stop', id: 15 },
      { ...at, method: TOUCH, leg: 'request', id: 0xffff_ffff, payload: undefined },
      { kind: 'handshake', leg: 'request', id: 16, version: 3, hello: 'opener' },
      { kind: 'handshake', leg: 'response', id: 16, outcome: ok('accepter') },
      { kind: 'handshake', leg: 'response', id: 17, outcome: err({ version: 9 }) },
      { kind: 'protocolError', id: 18, unsupportedMessage: { trait: 4, method: 200 } },
    ];

    // When
    const decoded = messages.map(message => decodeMessage(schema, encodeMessage(schema, message)));

    // Then
    expect(decoded).toEqual(messages);
  });

  it('As a transport, I encode Cancelled and am refused, since it never crosses the wire', () => {
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
      expect(encode).toThrow(TypeError);
      expect(encode).toThrow(/Cancelled/);
    }
  });

  it('As a transport, I encode what the wire cannot carry exactly and am refused with the reason', () => {
    // Given
    const at = { kind: 'method', trait: NOTES } as const;
    const attempts: [WireMessage, typeof RangeError | typeof TypeError, RegExp][] = [
      [{ ...at, method: TOUCH, leg: 'request', id: 2 ** 32, payload: undefined }, RangeError, /id 4294967296 is not/],
      [{ ...at, method: TOUCH, leg: 'request', id: -1, payload: undefined }, RangeError, /id -1 is not a u32/],
      [{ ...at, method: 9, leg: 'request', id: 1, payload: undefined }, RangeError, /no method 9 in trait 0/],
      [{ ...at, method: WATCH, leg: 'request', id: 1, payload: 'a start' }, TypeError, /request leg .* subscription/],
      [{ ...at, method: READ, leg: 'start', id: 1, payload: 'a start' }, TypeError, /start leg .* request method/],
      [{ ...at, method: READ, leg: 'interrupt', id: 1, outcome: ok() }, TypeError, /interrupt leg .* request/],
      [{ ...at, method: WATCH, leg: 'response', id: 1, outcome: ok() }, TypeError, /response leg .* subscription/],
      [{ ...at, method: TOUCH, leg: 'response', id: 1, outcome: err(domain('x')) }, TypeError, /no domain error/],
      [{ kind: 'handshake', leg: 'request', id: 1, version: 256, hello: 'hi' }, RangeError, /version 256 is not a u8/],
      [{ kind: 'protocolError', id: 1, unsupportedMessage: { trait: 1.5, method: 0 } }, RangeError, /trait 1.5 is/],
    ];

    // When
    const encodings = attempts.map(([message, type, reason]) => ({
      encode: () => encodeMessage(schema, message),
      type,
      reason,
    }));

    // Then
    for (const { encode, type, reason } of encodings) {
      expect(encode).toThrow(type);
      expect(encode).toThrow(reason);
    }
  });

  it('As a peer of any release, I encode a handshake request and get the frozen bytes', () => {
    // Given
    const message: WireMessage = { kind: 'handshake', leg: 'request', id: 1, version: 3, hello: 'hi' };

    // When
    const data = encodeMessage(schema, message);

    // Then
    expect(listed(data)).toEqual([1, 0, 0, 0, 255, 0, 0, 3, 0x68, 0x69]);
  });

  it('As a peer of any release, I encode both handshake responses and get the frozen bytes', () => {
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

  it('As a peer of any release, I encode a protocol error and get the frozen bytes', () => {
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

  it('As an accepter, I decode a handshake from another release and get its version without its hello', () => {
    // Given
    const newer = defineSchema({ version: 4, hello: byte, traits: {} });
    const data = encodeMessage(newer, { kind: 'handshake', leg: 'request', id: 5, version: 4, hello: 200 });

    // When
    const decoded = decodeMessage(schema, data);

    // Then
    expect(decoded).toEqual({ kind: 'handshake', leg: 'request', id: 5, version: 4, hello: undefined });
  });

  it('As a transport, I decode a message for a trait or method my schema lacks and get its address to reply to', () => {
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

  it('As a transport, I decode a header cut short and refuse it as malformed', () => {
    // Given
    const data = bytes(1, 0, 0, 0, NOTES, READ);

    // When
    const decoded = summarised(decodeMessage(schema, data));

    // Then
    expect(decoded).toEqual({ refused: 'malformed', cause: 'RangeError' });
  });

  it('As a transport, I decode an unknown leg byte and refuse it as malformed', () => {
    // Given
    const data = bytes(1, 0, 0, 0, NOTES, READ, 6);

    // When
    const decoded = summarised(decodeMessage(schema, data));

    // Then
    expect(decoded).toEqual({ refused: 'malformed', cause: 'RangeError' });
  });

  it('As a transport, I decode trailing bytes after a body that ends and refuse them as malformed', () => {
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
      { refused: 'malformed', cause: 'RangeError', header: { id: 1, trait: NOTES, method: WATCH, leg: 'stop' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 2, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'Error', header: { id: 3, trait: NOTES, method: WATCH, leg: 'interrupt' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 4, trait: 255, method: 0, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 5, trait: 255, method: 255, leg: 'response' } },
    ]);
  });

  it('As a transport, I decode an envelope with a tag the wire does not define and refuse it as malformed', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, NOTES, READ, 1, 2),
      bytes(2, 0, 0, 0, NOTES, READ, 1, 1, 5),
      bytes(3, 0, 0, 0, NOTES, READ, 1, 1, 6),
      bytes(4, 0, 0, 0, 255, 0, 1, 1, 1),
      bytes(5, 0, 0, 0, 255, 255, 1, 1, 7, 2),
    ];

    // When
    const decoded = messages.map(data => summarised(decodeMessage(schema, data)));

    // Then
    expect(decoded).toEqual([
      { refused: 'malformed', cause: 'RangeError', header: { id: 1, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 2, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 3, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 4, trait: 255, method: 0, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 5, trait: 255, method: 255, leg: 'response' } },
    ]);
  });

  it('As a transport, I decode a domain error on a method that declares none and refuse it as malformed', () => {
    // Given
    const data = bytes(1, 0, 0, 0, NOTES, TOUCH, 1, 1, 0);

    // When
    const decoded = summarised(decodeMessage(schema, data));

    // Then
    expect(decoded).toEqual({
      refused: 'malformed',
      cause: 'RangeError',
      header: { id: 1, trait: NOTES, method: TOUCH, leg: 'response' },
    });
  });

  it('As a transport, I decode a reason that is cut short, not canonical, too long or not UTF-8 and refuse it as malformed', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, NOTES, READ, 1, 1, 4, 8, 0x61),
      bytes(2, 0, 0, 0, NOTES, READ, 1, 1, 4, 0x05, 0x00, 0x61),
      bytes(3, 0, 0, 0, NOTES, READ, 1, 1, 3, 0x06, 0x00, 0x00, 0x00, 0x61),
      bytes(4, 0, 0, 0, NOTES, READ, 1, 1, 4, 0x04, 0xff),
      bytes(5, 0, 0, 0, NOTES, READ, 1, 1, 3, 0x08, 0xc3, 0x28),
      bytes(6, 0, 0, 0, NOTES, READ, 1, 1, 4, 0x03, 0x00, 0x00, 0x00, 0x40),
    ];

    // When
    const decoded = messages.map(data => summarised(decodeMessage(schema, data)));

    // Then
    expect(decoded).toEqual([
      { refused: 'malformed', cause: 'RangeError', header: { id: 1, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 2, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 3, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'TypeError', header: { id: 4, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'TypeError', header: { id: 5, trait: NOTES, method: READ, leg: 'response' } },
      { refused: 'malformed', cause: 'RangeError', header: { id: 6, trait: NOTES, method: READ, leg: 'response' } },
    ]);
  });

  it('As a serving side, I decode a leg that does not fit its method and refuse it as invalid', () => {
    // Given
    const messages = [
      bytes(1, 0, 0, 0, NOTES, WATCH, 0, 0x61),
      bytes(2, 0, 0, 0, NOTES, WATCH, 1, 0, 0x61),
      bytes(3, 0, 0, 0, NOTES, READ, 2, 0x61),
      bytes(4, 0, 0, 0, NOTES, READ, 3, 7),
      bytes(5, 0, 0, 0, NOTES, READ, 4, 0),
      bytes(6, 0, 0, 0, NOTES, READ, 5),
      bytes(7, 0, 0, 0, 255, 0, 5),
      bytes(8, 0, 0, 0, 255, 255, 0, 0, 7, 2),
    ];

    // When
    const decoded = messages.map(data => summarised(decodeMessage(schema, data)));

    // Then
    const invalid = (id: number, trait: number, method: number, leg: string) => ({
      refused: 'invalid',
      cause: 'TypeError',
      header: { id, trait, method, leg },
    });
    expect(decoded).toEqual([
      invalid(1, NOTES, WATCH, 'request'),
      invalid(2, NOTES, WATCH, 'response'),
      invalid(3, NOTES, READ, 'start'),
      invalid(4, NOTES, READ, 'receive'),
      invalid(5, NOTES, READ, 'interrupt'),
      invalid(6, NOTES, READ, 'stop'),
      invalid(7, 255, 0, 'stop'),
      invalid(8, 255, 255, 'request'),
    ]);
  });

  it('As a serving side, I decode a payload my decode throws on and refuse it as malformed with its cause', () => {
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
