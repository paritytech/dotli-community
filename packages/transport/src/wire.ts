// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A message is a header of `id: u32`, `trait: u8`, `method: u8` and `leg: u8`, then a body that is a scale-ts codec
// composed from the schema's codecs for that leg, with the user payload last and no length prefix. The header, the leg
// indices, the `Result` and `CallError` indices, the handshake on 255/0 and the protocol error on 255/255 are frozen,
// since a peer of any release reads them to tell versions apart.

import {
  Bytes,
  Enum,
  Result as ScaleResult,
  Struct,
  Tuple,
  _void,
  createCodec,
  createDecoder,
  enhanceCodec,
  str,
  u32,
  u8,
  type Codec as ScaleCodec,
} from 'scale-ts';
import { none, scaleOf, type Codec } from './codec.js';
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

export type Leg = 'request' | 'response' | 'start' | 'receive' | 'interrupt' | 'stop';

export const RESERVED_TRAIT = 255;
export const HANDSHAKE_METHOD = 0;
export const PROTOCOL_ERROR_METHOD = 255;

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
 * does not have, or a header the receiver bars. `header` is there once it is read, so the receiver can still answer the
 * sender.
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

/** Why a receiver bars a message on its header alone, before its body is read, or null to read it. */
export type Admit = (header: Header) => Error | null;

// scale-ts writes integers through a DataView, which wraps a number outside the type, so a value is checked first.
function ranged(codec: ScaleCodec<number>, max: number, type: string, label: string): ScaleCodec<number> {
  return enhanceCodec(
    codec,
    (value: number) => {
      if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`${label} ${String(value)} is not a ${type}`);
      }
      return value;
    },
    value => value,
  );
}

const rangedU8 = (label: string): ScaleCodec<number> => ranged(u8, 0xff, 'u8', label);

const legCodec = enhanceCodec(
  Enum({ request: _void, response: _void, start: _void, receive: _void, interrupt: _void, stop: _void }),
  (leg: Leg) => ({ tag: leg, value: undefined }),
  ({ tag }): Leg => tag,
);

/** Exported for the describer, which reads an unknown address's body as bytes after it. */
export const headerCodec: ScaleCodec<Header> = Struct({
  id: ranged(u32, 0xffff_ffff, 'u32', 'id'),
  trait: u8,
  method: u8,
  leg: legCodec,
});

/** The library's `Result` as a scale-ts `Result`. */
function outcome<T, E>(value: ScaleCodec<T>, error: ScaleCodec<E>): ScaleCodec<Result<T, E>> {
  return enhanceCodec(
    ScaleResult(value, error),
    (result: Result<T, E>) =>
      result.ok ? { success: true as const, value: result.value } : { success: false as const, value: result.error },
    decoded => (decoded.success ? ok(decoded.value) : err(decoded.value)),
  );
}

const reason = Struct({ reason: str });

/** The domain codec of a method that declares no error. Nothing crosses it. */
const undeclared = createCodec<unknown>(
  () => {
    throw new TypeError('the method declares no domain error');
  },
  createDecoder(() => {
    throw new RangeError('the method declares no domain error');
  }),
);

/** `CallError` with its indices pinned. `Cancelled` holds its index but never crosses. */
function callError(domainCodec: Codec<unknown> | undefined): ScaleCodec<CallError<unknown>> {
  const wire = Enum(
    {
      Domain: domainCodec === undefined ? undeclared : scaleOf(domainCodec),
      Denied: _void,
      Unsupported: _void,
      MalformedFrame: reason,
      HostFailure: reason,
      Cancelled: _void,
    },
    [0, 1, 2, 3, 4, 5],
  );
  type Wire = Parameters<typeof wire.enc>[0];
  return enhanceCodec(
    wire,
    (error: CallError<unknown>): Wire => {
      switch (error.tag) {
        case 'Domain':
          return error;
        case 'Denied':
        case 'Unsupported':
          return { tag: error.tag, value: undefined };
        case 'MalformedFrame':
        case 'HostFailure':
          return { tag: error.tag, value: { reason: error.reason } };
        case 'Cancelled':
          throw new TypeError('Cancelled is raised on the caller side and never crosses the wire');
      }
    },
    (decoded): CallError<unknown> => {
      switch (decoded.tag) {
        case 'Domain':
          return domain(decoded.value);
        case 'Denied':
          return denied();
        case 'Unsupported':
          return unsupported();
        case 'MalformedFrame':
          return malformedFrame(decoded.value.reason);
        case 'HostFailure':
          return hostFailure(decoded.value.reason);
        case 'Cancelled':
          throw new RangeError('Cancelled is raised on the caller side and never crosses the wire');
      }
    },
  );
}

/**
 * What a target reads on each of its legs. A body is a struct of the message's own fields, so it encodes from the
 * message and decodes into it. A leg the target lacks is invalid.
 */
interface Target {
  name: string;
  legs: Partial<Record<Leg, Body>>;
  message: (header: Header, body: object) => WireMessage;
}

/** A body codec. It encodes from the whole message, since a struct reads only its own fields. */
type Body = ScaleCodec<object>;

const asBody = <T extends object>(c: ScaleCodec<T>): Body => c as unknown as Body;
const payloadBody = (c: Codec<unknown>): Body => asBody(Struct({ payload: scaleOf(c) }));
const outcomeBody = <T, E>(c: ScaleCodec<Result<T, E>>): Body => asBody(Struct({ outcome: c }));

function methodTarget(impl: MethodImpl): Target {
  const message = (header: Header, body: object): WireMessage =>
    ({ kind: 'method', ...header, ...body }) as WireMessage;
  switch (impl.kind) {
    case 'request':
      return {
        name: 'a request method',
        legs: {
          request: payloadBody(impl.request),
          response: outcomeBody(outcome(scaleOf(impl.response), callError(impl.error))),
        },
        message,
      };
    case 'subscription':
      return {
        name: 'a subscription method',
        legs: {
          start: payloadBody(impl.start),
          receive: payloadBody(impl.receive),
          interrupt: outcomeBody(outcome(_void, callError(impl.interrupt))),
          stop: asBody(Struct({})),
        },
        message,
      };
  }
}

// A method's codecs are composed once, on its first message.
const methodTargets = new WeakMap<MethodImpl, Target>();

function methodTargetOf(impl: MethodImpl): Target {
  let target = methodTargets.get(impl);
  if (target === undefined) {
    target = methodTarget(impl);
    methodTargets.set(impl, target);
  }
  return target;
}

// The one error of a handshake response, at the index every release reads.
const versionMismatch = enhanceCodec(
  Enum({ VersionMismatch: Struct({ version: rangedU8('version') }) }),
  (value: { version: number }) => ({ tag: 'VersionMismatch' as const, value }),
  ({ value }) => value,
);

function handshakeTarget(schema: Schema): Target {
  const hello = scaleOf(schemaHello(schema) ?? (none as Codec<unknown>));
  const request = Struct({ version: rangedU8('version'), hello });
  return {
    name: 'the handshake',
    legs: {
      request: asBody(
        createCodec(
          request.enc,
          createDecoder(input => {
            const version = u8.dec(input);
            if (version !== schemaVersion(schema)) {
              // Another release's hello may not decode, so the rest of the message is skipped.
              Bytes(Infinity).dec(input);
              return { version, hello: undefined };
            }
            return { version, hello: hello.dec(input) };
          }),
        ),
      ),
      response: outcomeBody(outcome(hello, versionMismatch)),
    },
    message: (header, body) => ({ kind: 'handshake', id: header.id, leg: header.leg, ...body }) as HandshakeMessage,
  };
}

const PROTOCOL_ERROR_TARGET: Target = {
  name: 'the protocol error',
  legs: {
    response: asBody(
      Struct({
        unsupportedMessage: enhanceCodec(
          Enum({ UnsupportedMessage: Struct({ trait: rangedU8('trait'), method: rangedU8('method') }) }),
          (value: { trait: number; method: number }) => ({ tag: 'UnsupportedMessage' as const, value }),
          ({ value }) => value,
        ),
      }),
    ),
  },
  message: (header, body) => ({ kind: 'protocolError', id: header.id, ...body }) as ProtocolErrorMessage,
};

function targetAt(schema: Schema, trait: number, method: number): Target | undefined {
  if (trait !== RESERVED_TRAIT) {
    const impl = methodAt(schema, trait, method);
    return impl === undefined ? undefined : methodTargetOf(impl);
  }
  if (method === HANDSHAKE_METHOD) {
    return handshakeTarget(schema);
  }
  return method === PROTOCOL_ERROR_METHOD ? PROTOCOL_ERROR_TARGET : undefined;
}

function headerOf(message: WireMessage): Header {
  switch (message.kind) {
    case 'method':
      return { id: message.id, trait: message.trait, method: message.method, leg: message.leg };
    case 'handshake':
      return { id: message.id, trait: RESERVED_TRAIT, method: HANDSHAKE_METHOD, leg: message.leg };
    case 'protocolError':
      return { id: message.id, trait: RESERVED_TRAIT, method: PROTOCOL_ERROR_METHOD, leg: 'response' };
  }
}

const unfitLeg = (leg: Leg, target: Target): TypeError =>
  new TypeError(`the ${leg} leg does not belong to ${target.name}`);

/**
 * Encodes a message in one pass of its composed codec. Throws on what the wire cannot carry exactly: an id outside u32,
 * an address the schema lacks, a leg the method does not have, a domain error the method does not declare, or
 * `Cancelled`.
 */
export function encodeMessage(schema: Schema, message: WireMessage): ArrayBuffer {
  const header = headerOf(message);
  const target = targetAt(schema, header.trait, header.method);
  if (target === undefined) {
    throw new RangeError(`no method ${String(header.method)} in trait ${String(header.trait)}`);
  }
  const body = target.legs[header.leg];
  if (body === undefined) {
    throw unfitLeg(header.leg, target);
  }
  // A composed encode merges its parts into one fresh buffer of exactly the message's length.
  return Tuple(headerCodec, body).enc([header, message]).buffer as ArrayBuffer;
}

/** scale-ts hands a decoder its own byte array over the whole buffer, which carries the read position. */
type Cursor = Uint8Array & { i: number };

function readMessage(schema: Schema, admit: Admit, cursor: Cursor): DecodedMessage | Refusal {
  let header: Header;
  try {
    header = headerCodec.dec(cursor);
  } catch (cause) {
    return { refused: 'malformed', cause };
  }
  const barred = admit(header);
  if (barred !== null) {
    return { refused: 'invalid', cause: barred, header };
  }
  const { id, trait, method, leg } = header;
  const target = targetAt(schema, trait, method);
  if (target === undefined) {
    return { kind: 'unknownAddress', id, leg, unknownAddress: { trait, method } };
  }
  const body = target.legs[leg];
  if (body === undefined) {
    return { refused: 'invalid', cause: unfitLeg(leg, target), header };
  }
  try {
    const value = body.dec(cursor);
    if (cursor.i !== cursor.byteLength) {
      throw new RangeError(`${String(cursor.byteLength - cursor.i)} bytes follow a body that has ended`);
    }
    return target.message(header, value);
  } catch (cause) {
    return { refused: 'malformed', cause, header };
  }
}

const admitAll: Admit = () => null;

/**
 * Decodes a message in one pass: the header, then the body its target and leg name, which must end where the data
 * does. `admit` bars a message on its header before the body is read. The payload reaches the user's decode as a view
 * of `data`. An address the schema lacks is not refused, so the receiver can answer it.
 */
export function decodeMessage(schema: Schema, data: ArrayBuffer, admit: Admit = admitAll): DecodedMessage | Refusal {
  return createDecoder(input => readMessage(schema, admit, input as Cursor))(data);
}
