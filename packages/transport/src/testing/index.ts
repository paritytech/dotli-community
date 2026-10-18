// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { wireOf, type Schema } from '../schema.js';

export { createProviderPair } from '../provider.fake.js';

/**
 * A message as a test reads it. The body is the leg's decoded value, left as it is. The library's own messages are on
 * the trait `#library`, and an address the schema lacks is named by its numeric ids, with no body.
 */
export interface DescribedMessage {
  trait: string;
  method: string;
  leg: string;
  id: number;
  body: unknown;
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

/** Describes a recorded message by its names, leg, id and decoded body. Throws a `MessageRefusedError` on refused data. */
export function describeMessage(schema: Schema, data: ArrayBuffer): DescribedMessage {
  const received = wireOf(schema).decode(data);
  switch (received.kind) {
    case 'message': {
      const { value, ...header } = received.message;
      return { ...header, body: value };
    }
    case 'unknownAddress': {
      const { id, leg, trait, method } = received;
      return { trait: String(trait), method: String(method), leg, id, body: undefined };
    }
    case 'refused':
      throw new MessageRefusedError(received.reason, received.cause);
  }
}
