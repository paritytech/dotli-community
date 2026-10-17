// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One message is a header (id, method index, leg) followed by the leg's codec from the method table.

import { Struct, createDecoder, str, u8, type Codec } from 'scale-ts';
import { errorName, serializeError, toError } from '@dotli/shared';
import { decodeExact, nullable, safeInteger, u32Exact } from './codec-primitives.js';
import {
  METHOD_NAMES,
  PROTOCOL_METHODS,
  type Answer,
  type ProtocolMethod,
  type RequestMethod,
  type RequestPayload,
  type SubscribePayload,
  type SubscriptionEvent,
  type SubscriptionMethod,
} from './methods.js';

// Enough for the frames that locate the throw without bloating every failed response.
const MAX_STACK_CHARS = 2000;

export interface WireError {
  message: string;
  name: string | null;
  stack: string | null;
}

/** A method a request leg may name: every request method and the handshake. */
export type Requestable = RequestMethod | 'handshake';

/** The failure a receiver rebuilds, carrying the class name and stack its own error cannot have. */
export function toWireError(error: unknown): WireError {
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    message: serializeError(error),
    name: errorName(error) ?? null,
    stack: typeof stack === 'string' && stack !== '' ? stack.slice(0, MAX_STACK_CHARS) : null,
  };
}

export type ResponseOutcome<M extends Requestable> = { ok: true; answer: Answer<M> } | { ok: false; error: WireError };

// Each leg maps over its method parameter, so a message built for a generic method `M` is a `RequestMessage<M>`, and
// the default parameter gives the union of every method's leg.
export type RequestMessage<M extends Requestable = Requestable> = {
  [P in M]: { leg: 'request'; id: number; method: P; deadlineMs: number | null; payload: RequestPayload<P> };
}[M];
export type ResponseMessage<M extends Requestable = Requestable> = {
  [P in M]: { leg: 'response'; id: number; method: P; outcome: ResponseOutcome<P> };
}[M];
export type SubscribeMessage<M extends SubscriptionMethod = SubscriptionMethod> = {
  [P in M]: { leg: 'subscribe'; id: number; method: P; deadlineMs: number | null; payload: SubscribePayload<P> };
}[M];
export type EventMessage<M extends SubscriptionMethod = SubscriptionMethod> = {
  [P in M]: { leg: 'event'; id: number; method: P; event: SubscriptionEvent<P> };
}[M];

export interface EndMessage {
  leg: 'end';
  id: number;
  method: SubscriptionMethod;
  error: WireError | null;
}

export interface UnsubscribeMessage {
  leg: 'unsubscribe';
  id: number;
  method: SubscriptionMethod;
}

export type WireMessage =
  RequestMessage | ResponseMessage | SubscribeMessage | EventMessage | EndMessage | UnsubscribeMessage;

type Leg = WireMessage['leg'];

// The header (u32 id, u8 method index, u8 leg index), the request's body (an optional u64 deadline, then the payload),
// the response's outcome tag and the error layout never change, and neither does the order of these legs, since a peer
// of any release reads them to tell the versions apart.
const LEGS: readonly Leg[] = ['request', 'response', 'subscribe', 'event', 'end', 'unsubscribe'];

const wireErrorCodec: Codec<WireError> = Struct({ message: str, name: nullable(str), stack: nullable(str) });
const deadlineCodec = nullable(safeInteger);

/** A table entry with its payload types erased, since the method is only known at run time. */
interface LooseEntry {
  kind: 'request' | 'subscription';
  payload: Codec<unknown>;
  answer?: Codec<unknown>;
  event?: Codec<unknown>;
  check?: (event: unknown) => boolean;
}

/** What every message has, whatever its method. */
interface WireHeader {
  leg: Leg;
  id: number;
  method: ProtocolMethod;
}

/** A message with its method-dependent fields erased, for the dispatch that knows the leg but not the method. */
interface LooseMessage extends WireHeader {
  deadlineMs: number | null;
  payload: unknown;
  event: unknown;
  outcome: { ok: true; answer: unknown } | { ok: false; error: WireError };
  error: WireError | null;
}

/** What follows the header. Fields are the message's own, so the body decodes straight into the message. */
type Body = Record<string, unknown>;

function entryOf(method: ProtocolMethod): LooseEntry {
  return PROTOCOL_METHODS[method] as unknown as LooseEntry;
}

function concat(parts: Uint8Array[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('method table entry is missing a codec for its leg');
  }
  return value;
}

function expectKind(entry: LooseEntry, kind: LooseEntry['kind']): void {
  if (entry.kind !== kind) {
    throw new TypeError(`a ${kind} leg does not belong to a ${entry.kind} method`);
  }
}

function encodeBody(m: LooseMessage, entry: LooseEntry): Uint8Array[] {
  switch (m.leg) {
    case 'request':
      expectKind(entry, 'request');
      return [deadlineCodec.enc(m.deadlineMs), entry.payload.enc(m.payload)];
    case 'response': {
      expectKind(entry, 'request');
      const outcome = m.outcome;
      return outcome.ok
        ? [u8.enc(0), required(entry.answer).enc(outcome.answer)]
        : [u8.enc(1), wireErrorCodec.enc(outcome.error)];
    }
    case 'subscribe':
      expectKind(entry, 'subscription');
      return [deadlineCodec.enc(m.deadlineMs), entry.payload.enc(m.payload)];
    case 'event':
      expectKind(entry, 'subscription');
      return [required(entry.event).enc(m.event)];
    case 'end':
      expectKind(entry, 'subscription');
      return [nullable(wireErrorCodec).enc(m.error)];
    case 'unsubscribe':
      expectKind(entry, 'subscription');
      return [];
  }
}

function decodeBody(leg: Leg, entry: LooseEntry, input: Uint8Array): Body {
  switch (leg) {
    case 'request':
      expectKind(entry, 'request');
      return { deadlineMs: deadlineCodec.dec(input), payload: entry.payload.dec(input) };
    case 'response': {
      expectKind(entry, 'request');
      const tag = u8.dec(input);
      if (tag === 0) {
        return { outcome: { ok: true, answer: required(entry.answer).dec(input) } };
      }
      if (tag === 1) {
        return { outcome: { ok: false, error: wireErrorCodec.dec(input) } };
      }
      throw new RangeError(`unknown outcome ${String(tag)}`);
    }
    case 'subscribe':
      expectKind(entry, 'subscription');
      return { deadlineMs: deadlineCodec.dec(input), payload: entry.payload.dec(input) };
    case 'event':
      expectKind(entry, 'subscription');
      return { event: required(entry.event).dec(input) };
    case 'end':
      expectKind(entry, 'subscription');
      return { error: nullable(wireErrorCodec).dec(input) };
    case 'unsubscribe':
      expectKind(entry, 'subscription');
      return {};
  }
}

/**
 * Throws `RangeError` for an id or deadline the wire cannot carry exactly. A message built for a generic method takes
 * the first two signatures, which hold its payload, answer or event to that method.
 */
export function encodeWireMessage<M extends Requestable>(message: RequestMessage<M> | ResponseMessage<M>): ArrayBuffer;
export function encodeWireMessage<M extends SubscriptionMethod>(
  message: SubscribeMessage<M> | EventMessage<M>,
): ArrayBuffer;
export function encodeWireMessage(message: WireMessage): ArrayBuffer;
export function encodeWireMessage(message: WireHeader): ArrayBuffer {
  // Every signature above is a message, whose method-dependent fields the table's loose entry reads.
  const loose = message as LooseMessage;
  return concat([
    u32Exact.enc(loose.id),
    u8.enc(METHOD_NAMES.indexOf(loose.method)),
    u8.enc(LEGS.indexOf(loose.leg)),
    ...encodeBody(loose, entryOf(loose.method)),
  ]);
}

export type DecodedWireMessage =
  { ok: true; message: WireMessage } | { ok: false; reason: 'malformed' | 'invalid'; cause: Error };

/**
 * `malformed` is bytes that are no message. `invalid` is a message whose values the method refuses. A refusal's
 * `cause` says what failed, for the receiver's log.
 */
export function decodeWireMessage(data: ArrayBuffer): DecodedWireMessage {
  let message: WireMessage;
  try {
    message = decodeExact(
      createDecoder(input => {
        const id = u32Exact.dec(input);
        const methodIndex = u8.dec(input);
        const legIndex = u8.dec(input);
        const method = METHOD_NAMES[methodIndex];
        const leg = LEGS[legIndex];
        if (method === undefined || leg === undefined) {
          throw new RangeError(`unknown method ${String(methodIndex)} or leg ${String(legIndex)}`);
        }
        return { leg, id, method, ...decodeBody(leg, entryOf(method), input) } as WireMessage;
      }),
      data,
    );
  } catch (error) {
    // A refused message is counted and logged by the receiver, from the reason and the cause.
    return { ok: false, reason: 'malformed', cause: toError(error) };
  }
  if (message.leg === 'event') {
    const check = entryOf(message.method).check;
    if (check !== undefined && !check(message.event)) {
      return { ok: false, reason: 'invalid', cause: new RangeError(`a ${message.method} event fails its check`) };
    }
  }
  return { ok: true, message };
}
