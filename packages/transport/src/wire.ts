// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A message is `[id: u32][trait: u8][method: u8][leg: u8]`, then the leg's envelope, then the user payload with no
// length prefix. The header, the leg bytes, the result and error tags, the handshake on 255/0 and the protocol error on
// 255/255 are frozen, since a peer of any release reads them to tell versions apart.

import { createDecoder, str, u32, u8 } from 'scale-ts';
import { decodeValue, encodeValue, none, type Codec } from './codec.js';
import {
  denied,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
  type Result,
} from './result.js';
import { methodAt, schemaHello, schemaVersion, type MethodImpl, type Schema } from './schema.js';

/** The legs in their wire order. */
const LEGS = ['request', 'response', 'start', 'receive', 'interrupt', 'stop'] as const;

export type Leg = (typeof LEGS)[number];

/** The `CallError` tags in their wire order. `Cancelled` holds its index but never crosses. */
const CALL_ERROR_TAGS: readonly CallError<unknown>['tag'][] = [
  'Domain',
  'Denied',
  'Unsupported',
  'MalformedFrame',
  'HostFailure',
  'Cancelled',
];

export const HEADER_BYTES = 7;
export const RESERVED_TRAIT = 255;
export const HANDSHAKE_METHOD = 0;
export const PROTOCOL_ERROR_METHOD = 255;

const OK = 0;
const ERR = 1;
const DOMAIN = 0;
const UNSUPPORTED_MESSAGE = 0;
const EMPTY = new Uint8Array(0);

/** A message on a schema method, addressed by its wire ids. */
export type MethodMessage =
  | {
      kind: 'method';
      leg: 'request' | 'start' | 'receive';
      id: number;
      trait: number;
      method: number;
      payload: unknown;
    }
  | {
      kind: 'method';
      leg: 'response' | 'interrupt';
      id: number;
      trait: number;
      method: number;
      outcome: Result<unknown, CallError<unknown>>;
    }
  | { kind: 'method'; leg: 'stop'; id: number; trait: number; method: number };

/**
 * The handshake. A response's error is a version mismatch naming the accepter's version. A request's `hello` is read
 * only when its version is ours, since another release's hello may not decode, and is `undefined` otherwise.
 */
export type HandshakeMessage =
  | { kind: 'handshake'; leg: 'request'; id: number; version: number; hello: unknown }
  | { kind: 'handshake'; leg: 'response'; id: number; outcome: Result<unknown, { version: number }> };

/** The reply to a message whose address the receiver lacks. Nothing answers it. */
export interface ProtocolErrorMessage {
  kind: 'protocolError';
  id: number;
  unsupportedMessage: { trait: number; method: number };
}

export type WireMessage = MethodMessage | HandshakeMessage | ProtocolErrorMessage;

/** A message for a trait or method this schema lacks. Its body is not read, since only the sender has its codecs. */
export interface UnknownAddressMessage {
  kind: 'unknownAddress';
  id: number;
  leg: Leg;
  unknownAddress: { trait: number; method: number };
}

export type DecodedMessage = WireMessage | UnknownAddressMessage;

/**
 * Data the receiver drops. `malformed` is bytes that are no message, a payload included. `invalid` is a leg its method
 * does not have. `header` is there once the address and leg are read, so the receiver can still answer the sender.
 */
export interface Refusal {
  refused: 'malformed' | 'invalid';
  cause: unknown;
  header?: Header;
}

/** What precedes every body. */
export interface Header {
  id: number;
  trait: number;
  method: number;
  leg: Leg;
}

type Target = MethodImpl | { kind: 'handshake' } | { kind: 'protocolError' };

/** A leg its target does not have. Its own class, so a decode refuses it as invalid rather than malformed. */
class UnfitLeg extends TypeError {
  constructor(leg: Leg, target: Target['kind']) {
    super(`a ${leg} leg does not belong to a ${target} method`);
  }
}

/** scale-ts hands decoders its byte array over the whole buffer, which carries the read position. */
interface Cursor extends Uint8Array {
  i: number;
}

// scale-ts decoders read `view.buffer` and ignore a view's offset, so the cursor always spans the whole message.
const toCursor = createDecoder(input => input as Cursor);

function checkU8(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${label} ${String(value)} is not a u8`);
  }
  return value;
}

function checkU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} ${String(value)} is not a u32`);
  }
  return value;
}

const helloCodec = (schema: Schema): Codec<unknown> => schemaHello(schema) ?? (none as Codec<unknown>);

interface Body {
  trait: number;
  method: number;
  leg: Leg;
  envelope: readonly number[];
  payload: Uint8Array;
}

function outcomeBody(
  outcome: Result<unknown, CallError<unknown>>,
  value: Codec<unknown>,
  domainCodec: Codec<unknown> | undefined,
): Pick<Body, 'envelope' | 'payload'> {
  if (outcome.ok) {
    return { envelope: [OK], payload: encodeValue(value, outcome.value) };
  }
  const error = outcome.error;
  const tag = CALL_ERROR_TAGS.indexOf(error.tag);
  switch (error.tag) {
    case 'Domain':
      if (domainCodec === undefined) {
        throw new TypeError('the method declares no domain error');
      }
      return { envelope: [ERR, tag], payload: encodeValue(domainCodec, error.value) };
    case 'Denied':
    case 'Unsupported':
      return { envelope: [ERR, tag], payload: EMPTY };
    case 'MalformedFrame':
    case 'HostFailure':
      return { envelope: [ERR, tag], payload: str.enc(error.reason) };
    case 'Cancelled':
      throw new TypeError('Cancelled is raised on the caller side and never crosses the wire');
  }
}

function methodBody(schema: Schema, message: MethodMessage): Body {
  const target = methodAt(schema, message.trait, message.method);
  if (target === undefined) {
    throw new RangeError(`no method ${String(message.method)} in trait ${String(message.trait)}`);
  }
  const at = { trait: message.trait, method: message.method, leg: message.leg };
  switch (target.kind) {
    case 'request':
      if (message.leg === 'request') {
        return { ...at, envelope: [], payload: encodeValue(target.request, message.payload) };
      }
      if (message.leg === 'response') {
        return { ...at, ...outcomeBody(message.outcome, target.response, target.error) };
      }
      break;
    case 'subscription':
      if (message.leg === 'start') {
        return { ...at, envelope: [], payload: encodeValue(target.start, message.payload) };
      }
      if (message.leg === 'receive') {
        return { ...at, envelope: [], payload: encodeValue(target.receive, message.payload) };
      }
      if (message.leg === 'interrupt') {
        return { ...at, ...outcomeBody(message.outcome, none as Codec<unknown>, target.interrupt) };
      }
      if (message.leg === 'stop') {
        return { ...at, envelope: [], payload: EMPTY };
      }
      break;
  }
  throw new UnfitLeg(message.leg, target.kind);
}

function bodyOf(schema: Schema, message: WireMessage): Body {
  switch (message.kind) {
    case 'method':
      return methodBody(schema, message);
    case 'handshake': {
      const at = { trait: RESERVED_TRAIT, method: HANDSHAKE_METHOD, leg: message.leg };
      if (message.leg === 'request') {
        const envelope = [checkU8(message.version, 'version')];
        return { ...at, envelope, payload: encodeValue(helloCodec(schema), message.hello) };
      }
      return message.outcome.ok
        ? { ...at, envelope: [OK], payload: encodeValue(helloCodec(schema), message.outcome.value) }
        : { ...at, envelope: [ERR, DOMAIN, checkU8(message.outcome.error.version, 'version')], payload: EMPTY };
    }
    case 'protocolError': {
      const { trait, method } = message.unsupportedMessage;
      return {
        trait: RESERVED_TRAIT,
        method: PROTOCOL_ERROR_METHOD,
        leg: 'response',
        envelope: [UNSUPPORTED_MESSAGE, checkU8(trait, 'trait'), checkU8(method, 'method')],
        payload: EMPTY,
      };
    }
  }
}

/**
 * Writes a message into one buffer: the header and envelope, then the payload copied once. Throws on what the wire
 * cannot carry exactly: an id outside u32, an address the schema lacks, a leg the method does not have, a domain error
 * the method does not declare, or `Cancelled`.
 */
export function encodeMessage(schema: Schema, message: WireMessage): ArrayBuffer {
  const id = checkU32(message.id, 'id');
  const body = bodyOf(schema, message);
  const out = new Uint8Array(HEADER_BYTES + body.envelope.length + body.payload.length);
  new DataView(out.buffer).setUint32(0, id, true);
  out[4] = body.trait;
  out[5] = body.method;
  out[6] = LEGS.indexOf(body.leg);
  out.set(body.envelope, HEADER_BYTES);
  out.set(body.payload, HEADER_BYTES + body.envelope.length);
  return out.buffer;
}

function end(cursor: Cursor): void {
  if (cursor.i !== cursor.byteLength) {
    throw new RangeError(`${String(cursor.byteLength - cursor.i)} bytes follow a body that has ended`);
  }
}

// The payload runs to the end of the message, so the user's decode gets a view of exactly its bytes, with no copy.
function readPayload(c: Codec<unknown>, cursor: Cursor): unknown {
  return decodeValue(c, new Uint8Array(cursor.buffer, cursor.i));
}

function readOutcome(
  cursor: Cursor,
  value: Codec<unknown>,
  domainCodec: Codec<unknown> | undefined,
): Result<unknown, CallError<unknown>> {
  const tag = u8.dec(cursor);
  if (tag === OK) {
    return ok(readPayload(value, cursor));
  }
  if (tag !== ERR) {
    throw new RangeError(`${String(tag)} is not a result tag`);
  }
  const errorTag = u8.dec(cursor);
  const error = CALL_ERROR_TAGS[errorTag];
  if (error === undefined || error === 'Cancelled') {
    throw new RangeError(`${String(errorTag)} is not a call error that crosses the wire`);
  }
  switch (error) {
    case 'Domain':
      if (domainCodec === undefined) {
        throw new RangeError('the method declares no domain error');
      }
      return err(domain(readPayload(domainCodec, cursor)));
    case 'Denied':
      end(cursor);
      return err(denied());
    case 'Unsupported':
      end(cursor);
      return err(unsupported());
    case 'MalformedFrame': {
      const reason = str.dec(cursor);
      end(cursor);
      return err(malformedFrame(reason));
    }
    case 'HostFailure': {
      const reason = str.dec(cursor);
      end(cursor);
      return err(hostFailure(reason));
    }
  }
}

function readHandshake(schema: Schema, leg: Leg, id: number, cursor: Cursor): HandshakeMessage {
  if (leg !== 'request' && leg !== 'response') {
    throw new UnfitLeg(leg, 'handshake');
  }
  if (leg === 'request') {
    const version = u8.dec(cursor);
    const hello = version === schemaVersion(schema) ? readPayload(helloCodec(schema), cursor) : undefined;
    return { kind: 'handshake', leg, id, version, hello };
  }
  const tag = u8.dec(cursor);
  if (tag === OK) {
    return { kind: 'handshake', leg: 'response', id, outcome: ok(readPayload(helloCodec(schema), cursor)) };
  }
  if (tag !== ERR || u8.dec(cursor) !== DOMAIN) {
    throw new RangeError('a handshake response is Ok or a version mismatch');
  }
  const version = u8.dec(cursor);
  end(cursor);
  return { kind: 'handshake', leg: 'response', id, outcome: err({ version }) };
}

function readProtocolError(leg: Leg, id: number, cursor: Cursor): ProtocolErrorMessage {
  if (leg !== 'response') {
    throw new UnfitLeg(leg, 'protocolError');
  }
  const tag = u8.dec(cursor);
  if (tag !== UNSUPPORTED_MESSAGE) {
    throw new RangeError(`${String(tag)} is not a protocol error`);
  }
  const trait = u8.dec(cursor);
  const method = u8.dec(cursor);
  end(cursor);
  return { kind: 'protocolError', id, unsupportedMessage: { trait, method } };
}

function readMethod(target: MethodImpl, header: Header, cursor: Cursor): MethodMessage {
  const { id, trait, method, leg } = header;
  const at = { kind: 'method', id, trait, method } as const;
  switch (target.kind) {
    case 'request':
      if (leg === 'request') {
        return { ...at, leg, payload: readPayload(target.request, cursor) };
      }
      if (leg === 'response') {
        return { ...at, leg, outcome: readOutcome(cursor, target.response, target.error) };
      }
      break;
    case 'subscription':
      if (leg === 'start') {
        return { ...at, leg, payload: readPayload(target.start, cursor) };
      }
      if (leg === 'receive') {
        return { ...at, leg, payload: readPayload(target.receive, cursor) };
      }
      if (leg === 'interrupt') {
        return { ...at, leg, outcome: readOutcome(cursor, none as Codec<unknown>, target.interrupt) };
      }
      if (leg === 'stop') {
        end(cursor);
        return { ...at, leg };
      }
      break;
  }
  throw new UnfitLeg(leg, target.kind);
}

function targetAt(schema: Schema, trait: number, method: number): Target | undefined {
  if (trait !== RESERVED_TRAIT) {
    return methodAt(schema, trait, method);
  }
  if (method === HANDSHAKE_METHOD) {
    return { kind: 'handshake' };
  }
  return method === PROTOCOL_ERROR_METHOD ? { kind: 'protocolError' } : undefined;
}

/**
 * Reads a message strictly: a whole header, a known leg, a leg its method has and a body that ends where the data
 * does. The payload reaches the user's decode as a view of `data`. An address the schema lacks is not refused, so the
 * receiver can answer it.
 */
export function decodeMessage(schema: Schema, data: ArrayBuffer): DecodedMessage | Refusal {
  if (data.byteLength < HEADER_BYTES) {
    const cause = new RangeError(`a ${String(HEADER_BYTES)}-byte header, got ${String(data.byteLength)} bytes`);
    return { refused: 'malformed', cause };
  }
  const cursor = toCursor(data);
  const id = u32.dec(cursor);
  const trait = u8.dec(cursor);
  const method = u8.dec(cursor);
  const legByte = u8.dec(cursor);
  const leg = LEGS[legByte];
  if (leg === undefined) {
    return { refused: 'malformed', cause: new RangeError(`${String(legByte)} is not a leg`) };
  }
  const target = targetAt(schema, trait, method);
  if (target === undefined) {
    return { kind: 'unknownAddress', id, leg, unknownAddress: { trait, method } };
  }
  const header: Header = { id, trait, method, leg };
  try {
    switch (target.kind) {
      case 'handshake':
        return readHandshake(schema, leg, id, cursor);
      case 'protocolError':
        return readProtocolError(leg, id, cursor);
      case 'request':
      case 'subscription':
        return readMethod(target, header, cursor);
    }
  } catch (cause) {
    // Each reader checks the leg before it reads a byte of the body, so an unfit leg is never a payload's failure.
    return { refused: cause instanceof UnfitLeg ? 'invalid' : 'malformed', cause, header };
  }
}
