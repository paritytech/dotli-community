// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A message is one scale-ts codec composed from the schema, laid out as a truapi frame:
// `[id: u32][trait: u8][method: u8][leg: u8][body]`. Trait, method and leg are nested enums, so a message reads as names,
// and the body is the leg's codec with the user's payload last. The library's own trait sits at 255, with the handshake
// at method 0 and the protocol error at 255. Their layout and the leg, `Result` and `CallError` indices are frozen, since
// a peer of any release reads them to tell versions apart.

import {
  Bytes,
  Enum,
  Struct,
  _void,
  createDecoder,
  enhanceCodec,
  str,
  u32,
  u8,
  type Codec as ScaleCodec,
} from 'scale-ts';
import { none, scaleOf, type Codec } from './codec.js';
import { err, ok, type CallError, type Result } from './result.js';

/** The legs, at their indices on the wire. */
const LEGS = ['request', 'response', 'start', 'receive', 'interrupt', 'stop'] as const;

export type Leg = (typeof LEGS)[number];

/** A message, addressed by names. `value` is what its leg carries: a payload, a `Result`, or nothing on a stop. */
export interface Message {
  id: number;
  trait: string;
  method: string;
  leg: Leg;
  value: unknown;
}

/** What addresses a message. */
export type Header = Omit<Message, 'value'>;

/** The name of the library's own trait. A schema name is an identifier, so none takes it. */
export const LIBRARY_TRAIT = '#library';

const LIBRARY_TRAIT_ID = 255;

/** An enum value: a variant's name and what it carries. */
interface Tagged<T = unknown> {
  tag: string;
  value: T;
}

/** A method's legs, and the codec that reads them. */
export interface MethodWire {
  legs: readonly Leg[];
  codec: ScaleCodec<Tagged>;
}

const asTagged = <T extends Tagged>(codec: ScaleCodec<T>): ScaleCodec<Tagged> => codec as unknown as ScaleCodec<Tagged>;

/** The library's `Result`, with `Ok` at 0 and `Err` at 1. */
function outcome<T, E>(value: ScaleCodec<T>, error: ScaleCodec<E>): ScaleCodec<Result<T, E>> {
  return enhanceCodec(
    Enum({ Ok: value, Err: error }),
    (result: Result<T, E>) =>
      result.ok ? { tag: 'Ok' as const, value: result.value } : { tag: 'Err' as const, value: result.error },
    decoded => (decoded.tag === 'Ok' ? ok(decoded.value) : err(decoded.value)),
  );
}

const reason = Struct({ reason: str });

/** `CallError` at truapi's indices. */
const callError = <E>(domain: ScaleCodec<E>): ScaleCodec<CallError<E>> =>
  Enum({
    Domain: domain,
    Denied: _void,
    Unsupported: _void,
    MalformedFrame: reason,
    HostFailure: reason,
    Cancelled: _void,
  });

// What `Domain` carries for a method that declares no error.
const nothing = none as Codec<unknown>;

/** A request's legs. A method that declares no error carries nothing in `Domain`. */
export function requestWire(request: Codec<unknown>, response: Codec<unknown>, error?: Codec<unknown>): MethodWire {
  return {
    legs: ['request', 'response'],
    codec: asTagged(
      Enum(
        {
          request: scaleOf(request),
          response: outcome(scaleOf(response), callError(scaleOf(error ?? nothing))),
        },
        [0, 1],
      ),
    ),
  };
}

/** A subscription's legs. A method that declares no end reason carries nothing in `Domain`. */
export function subscriptionWire(
  start: Codec<unknown>,
  receive: Codec<unknown>,
  interrupt?: Codec<unknown>,
): MethodWire {
  return {
    legs: ['start', 'receive', 'interrupt', 'stop'],
    codec: asTagged(
      Enum(
        {
          start: scaleOf(start),
          receive: scaleOf(receive),
          interrupt: outcome(_void, callError(scaleOf(interrupt ?? nothing))),
          stop: _void,
        },
        [2, 3, 4, 5],
      ),
    ),
  };
}

/** Decodes all of `data`. scale-ts hands a decoder its read position as `i`, which must reach the end. */
function decodeAll<T>(codec: ScaleCodec<T>, data: Uint8Array | ArrayBuffer): T {
  return createDecoder(input => {
    const value = codec.dec(input);
    const left = input.length - (input as Uint8Array & { i: number }).i;
    if (left > 0) {
      throw new RangeError(`${String(left)} bytes follow the end of the message`);
    }
    return value;
  })(data);
}

/**
 * The handshake: this side's version and hello, answered with the peer's hello or the version the peer speaks. A hello
 * is read only at this side's version, since another release's may not decode.
 */
function handshakeWire(version: number, hello: ScaleCodec<unknown>): MethodWire {
  const request = enhanceCodec(
    Struct({ version: u8, hello: Bytes(Infinity) }),
    (value: { version: number; hello: unknown }) => ({ version: value.version, hello: hello.enc(value.hello) }),
    decoded => ({
      version: decoded.version,
      hello: decoded.version === version ? decodeAll(hello, decoded.hello) : undefined,
    }),
  );
  const versionMismatch = Enum({ VersionMismatch: Struct({ version: u8 }) });
  return {
    legs: ['request', 'response'],
    codec: asTagged(Enum({ request, response: outcome(hello, versionMismatch) }, [0, 1])),
  };
}

/** The answer to a message at an address the receiver lacks, which names the address by its ids. */
const protocolErrorWire: MethodWire = {
  legs: ['response'],
  codec: asTagged(Enum({ response: Enum({ UnsupportedMessage: Struct({ trait: u8, method: u8 }) }) }, [1])),
};

/** What a receiver makes of data. */
export type Received =
  | { kind: 'message'; message: Message }
  /** A message at an address the schema lacks, which its sender is told by the address's ids. */
  | { kind: 'unknownAddress'; id: number; leg: Leg; trait: number; method: number }
  /**
   * Data that is no message, or a leg its method does not have. `header` names the message when its address could be
   * read, so its sender can still be answered.
   */
  | { kind: 'refused'; reason: 'malformed' | 'invalid'; cause: unknown; header?: Header };

export interface Wire {
  /** Encodes a message into a fresh buffer. Throws on a value its leg's codec cannot carry. */
  encode(message: Message): ArrayBuffer;
  /** Decodes all of `data` in one pass. The bytes after a payload go to the user's decode. */
  decode(data: ArrayBuffer): Received;
}

interface Entry<T> {
  id: number;
  name: string;
  value: T;
}

const entries = <T>(record: Readonly<Record<string, T>>): Entry<T>[] =>
  Object.entries(record).map(([name, value], id) => ({ id, name, value }));

/** An enum over names known only at runtime, at their ids. `Enum` types its indices by keys, which a record lacks. */
const enumOf = <T>(variants: readonly Entry<ScaleCodec<T>>[]): ScaleCodec<Tagged<T>> =>
  Enum(
    Object.fromEntries(variants.map(({ name, value }) => [name, value])) as never,
    variants.map(({ id }) => id) as never,
  ) as unknown as ScaleCodec<Tagged<T>>;

/** The ids that address a message, read alone when the message as a whole does not decode. */
const addressIds = Struct({ id: u32, trait: u8, method: u8, leg: u8 });

/** Composes the message codec of a schema's version, hello and traits. Trait and method ids are their positions. */
export function createWire(
  version: number,
  hello: Codec<unknown>,
  traits: Readonly<Record<string, Readonly<Record<string, MethodWire>>>>,
): Wire {
  const all: Entry<Entry<MethodWire>[]>[] = [
    ...entries(traits).map(trait => ({ ...trait, value: entries(trait.value) })),
    {
      id: LIBRARY_TRAIT_ID,
      name: LIBRARY_TRAIT,
      value: [
        { id: 0, name: 'handshake', value: handshakeWire(version, scaleOf(hello)) },
        { id: 255, name: 'protocolError', value: protocolErrorWire },
      ],
    },
  ];
  const call = enumOf(
    all.map(trait => ({ ...trait, value: enumOf(trait.value.map(m => ({ ...m, value: m.value.codec }))) })),
  );
  const codec = enhanceCodec(
    Struct({ id: u32, call }),
    ({ id, trait, method, leg, value }: Message) => ({
      id,
      call: { tag: trait, value: { tag: method, value: { tag: leg, value } } },
    }),
    ({
      id,
      call: {
        tag: trait,
        value: { tag: method, value: leg },
      },
    }): Message => ({
      id,
      trait,
      method,
      leg: leg.tag as Leg,
      value: leg.value,
    }),
  );

  /** Reads back what data that did not decode was addressed to. */
  const refusal = (data: ArrayBuffer, cause: unknown): Received => {
    let ids: { id: number; trait: number; method: number; leg: number };
    try {
      ids = addressIds.dec(data);
    } catch {
      return { kind: 'refused', reason: 'malformed', cause };
    }
    const leg = LEGS[ids.leg];
    if (leg === undefined) {
      return { kind: 'refused', reason: 'malformed', cause };
    }
    const trait = all.find(entry => entry.id === ids.trait);
    const method = trait?.value.find(entry => entry.id === ids.method);
    if (trait === undefined || method === undefined) {
      return { kind: 'unknownAddress', id: ids.id, leg, trait: ids.trait, method: ids.method };
    }
    const header = { id: ids.id, trait: trait.name, method: method.name, leg };
    if (!method.value.legs.includes(leg)) {
      const invalid = new TypeError(`${trait.name}.${method.name} has no ${leg} leg`);
      return { kind: 'refused', reason: 'invalid', cause: invalid, header };
    }
    return { kind: 'refused', reason: 'malformed', cause, header };
  };

  return {
    encode: message => codec.enc(message).buffer as ArrayBuffer,
    decode(data) {
      try {
        return { kind: 'message', message: decodeAll(codec, data) };
      } catch (cause) {
        return refusal(data, cause);
      }
    },
  };
}
