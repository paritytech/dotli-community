// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, Tuple } from 'scale-ts';
import { methodNamesAt, type Schema } from '../schema.js';
import {
  HANDSHAKE_METHOD,
  PROTOCOL_ERROR_METHOD,
  RESERVED_TRAIT,
  decodeMessage,
  headerCodec,
  type DecodedMessage,
} from '../wire.js';

export { createProviderPair } from '../provider.fake.js';

/** A message as a test reads it. The body is the leg's decoded value, left as it is. */
export interface DescribedMessage {
  trait: string;
  method: string;
  leg: string;
  id: number;
  body: unknown;
}

function describeDecoded(schema: Schema, message: DecodedMessage, data: ArrayBuffer): DescribedMessage {
  switch (message.kind) {
    case 'method': {
      const names = methodNamesAt(schema, message.trait, message.method);
      const body = 'payload' in message ? message.payload : 'outcome' in message ? message.outcome : undefined;
      return {
        trait: names?.trait ?? String(message.trait),
        method: names?.method ?? String(message.method),
        leg: message.leg,
        id: message.id,
        body,
      };
    }
    case 'handshake':
      return {
        trait: String(RESERVED_TRAIT),
        method: String(HANDSHAKE_METHOD),
        leg: message.leg,
        id: message.id,
        body: message.leg === 'request' ? { version: message.version, hello: message.hello } : message.outcome,
      };
    case 'protocolError':
      return {
        trait: String(RESERVED_TRAIT),
        method: String(PROTOCOL_ERROR_METHOD),
        leg: 'response',
        id: message.id,
        body: message.unsupportedMessage,
      };
    case 'unknownAddress':
      // Only the sender has the codecs for this address, so the body stays bytes.
      return {
        trait: String(message.unknownAddress.trait),
        method: String(message.unknownAddress.method),
        leg: message.leg,
        id: message.id,
        body: Tuple(headerCodec, Bytes(Infinity)).dec(data)[1],
      };
  }
}

/** Recorded data the schema refuses. `reason` says how, and `cause` is why. */
export class MessageRefusedError extends Error {
  readonly reason: 'malformed' | 'invalid';

  constructor(reason: 'malformed' | 'invalid', cause: unknown) {
    super(`The data is refused as ${reason}`, { cause });
    this.name = 'MessageRefusedError';
    this.reason = reason;
  }
}

/**
 * Describes a recorded message by its names, leg, id and decoded body. A reserved or unknown address is named by its
 * numeric ids. Throws a `MessageRefusedError` on data the schema refuses.
 */
export function describeMessage(schema: Schema, data: ArrayBuffer): DescribedMessage {
  const decoded = decodeMessage(schema, data);
  if ('refused' in decoded) {
    throw new MessageRefusedError(decoded.refused, decoded.cause);
  }
  return describeDecoded(schema, decoded, data);
}
