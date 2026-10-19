// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { fromHex, toError, toHex } from '@dotli/shared';
import type { Codec } from 'scale-ts';
import type { Failure } from '../errors.js';
import type { AnyMethod, Schema, Traits } from '../schema.js';
import { decode, frame, type Accept, type Open } from '../wire.js';

export { createProviderPair } from '../provider.fake.js';

/**
 * A frame as a test reads it. A call keeps its message's bytes, and the message as its method decoded it, read by its
 * tag. A call to a method the schema lacks is named by its numeric
 * ids, with no decoded message.
 */
export type RecordedFrame =
  | { id: number; kind: 'open'; value: Open }
  | { id: number; kind: 'accept'; value: Accept }
  | { id: number; kind: 'failed'; value: Failure }
  | { id: number; kind: 'call'; trait: string; method: string; message: Uint8Array; decoded: { tag: string } | null };

/** Recorded data that is no frame. `cause` is why. */
export class FrameRefusedError extends Error {
  constructor(cause: Error) {
    super('The data is no frame', { cause });
    this.name = 'FrameRefusedError';
  }
}

/** A message as the method it belongs to decodes it. */
function decodedBy(method: AnyMethod, message: Uint8Array): { tag: string } {
  try {
    return method.message.dec(message);
  } catch (error) {
    throw new FrameRefusedError(toError(error));
  }
}

/** Reads a recorded frame. Throws a `FrameRefusedError` on data that is no frame. */
export function readFrame<H, T extends Traits>(schema: Schema<H, T>, data: ArrayBuffer): RecordedFrame {
  const read = decode(frame, data);
  if (!read.success) {
    throw new FrameRefusedError(read.value);
  }
  const { id, body } = read.value;
  switch (body.tag) {
    case 'open':
      return { id, kind: 'open', value: body.value };
    case 'accept':
      return { id, kind: 'accept', value: body.value };
    case 'failed':
      return { id, kind: 'failed', value: body.value };
    case 'call': {
      const { trait, method, message } = body.value;
      const placed = schema.placeAt(trait, method);
      if (placed === undefined) {
        return { id, kind: 'call', trait: String(trait), method: String(method), message, decoded: null };
      }
      return {
        id,
        kind: 'call',
        trait: placed.address.trait,
        method: placed.address.method,
        message,
        decoded: decodedBy(placed.method, message),
      };
    }
  }
}

/**
 * A call's message as a recording keeps it: by its method's names and tag, with its bytes as hex, and as JSON with bytes
 * as hex, so a page can match it.
 */
export interface RecordedWireMessage {
  id: number;
  trait: string;
  method: string;
  tag: string;
  message: string;
  json: string;
}

/** Bytes and big integers as JSON keeps them. */
const plain = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? toHex(value) : typeof value === 'bigint' ? value.toString() : value;

/** Records a call's message read by `schema`, or gives null for the library's own frames and data that is no frame. */
export function recordMessage<H, T extends Traits>(
  schema: Schema<H, T>,
  data: ArrayBuffer,
): RecordedWireMessage | null {
  let recorded: RecordedFrame;
  try {
    recorded = readFrame(schema, data);
  } catch (error) {
    // Data that is no frame is not recorded. Any other throw is a fault.
    if (error instanceof FrameRefusedError) {
      return null;
    }
    throw error;
  }
  if (recorded.kind !== 'call' || recorded.decoded === null) {
    return null;
  }
  const { id, trait, method, message, decoded } = recorded;
  return { id, trait, method, tag: decoded.tag, message: toHex(message), json: JSON.stringify(decoded, plain) };
}

/** The recorded messages of `method`, decoded with it. */
export function messagesOf<H, T extends Traits, M>(
  schema: Schema<H, T>,
  method: AnyMethod & { readonly message: Codec<M> },
  recorded: readonly RecordedWireMessage[],
): M[] {
  const address = schema.addressOf(method);
  // Read as the method's own codec, so the messages come back typed by it.
  const codec: Codec<M> = method.message;
  return recorded
    .filter(message => message.trait === address.trait && message.method === address.method)
    .map(message => codec.dec(fromHex(message.message)));
}
