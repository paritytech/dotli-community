// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { fromHex, toHex } from '@dotli/shared';
import type { Codec } from 'scale-ts';
import type { Failure } from '../errors.js';
import type { AnyMethod, Schema, Sections } from '../schema.js';
import { decode, frame, type HandshakeOffer, type HandshakeResponse } from '../wire.js';

export { createProviderPair } from '../provider.fake.js';

/**
 * A frame as a test reads it. A call keeps its message's bytes, and the message as its method decoded it, read by its
 * tag. A call to a method the schema lacks is named by its numeric
 * ids, with no decoded message.
 */
export type RecordedFrame =
  | { id: number; kind: 'handshakeOffer'; value: HandshakeOffer }
  | { id: number; kind: 'handshakeResponse'; value: HandshakeResponse }
  | { id: number; kind: 'failed'; value: Failure }
  | { id: number; kind: 'call'; section: string; method: string; message: Uint8Array; decoded: { tag: string } | null };

/** Recorded data that is no frame. `cause` is why. */
export class FrameRefusedError extends Error {
  constructor(cause: Error) {
    super('The data is no frame', { cause });
    this.name = 'FrameRefusedError';
  }
}

/**
 * Reads a recorded frame: bytes a provider delivered, or a buffer posted between documents. Throws a
 * `FrameRefusedError` on data that is no frame.
 */
export function readFrame<H, T extends Sections>(schema: Schema<H, T>, data: Uint8Array | ArrayBuffer): RecordedFrame {
  const read = decode(frame.dec, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  if (!read.success) {
    throw new FrameRefusedError(read.value);
  }
  const { id, body } = read.value;
  switch (body.tag) {
    case 'handshakeOffer':
      return { id, kind: 'handshakeOffer', value: body.value };
    case 'handshakeResponse':
      return { id, kind: 'handshakeResponse', value: body.value };
    case 'failed':
      return { id, kind: 'failed', value: body.value };
    case 'call': {
      const { sectionId, methodId, message } = body.value;
      const method = schema.methodAt(sectionId, methodId);
      if (method === undefined) {
        return { id, kind: 'call', section: String(sectionId), method: String(methodId), message, decoded: null };
      }
      const { section, method: name } = schema.addressOf(method);
      const decoded = decode(method.message.dec, message);
      if (!decoded.success) {
        throw new FrameRefusedError(decoded.value);
      }
      return { id, kind: 'call', section, method: name, message, decoded: decoded.value };
    }
  }
}

/**
 * A call's message as a recording keeps it: by its method's names and tag, with its bytes as hex, and as JSON with bytes
 * as hex, so a page can match it.
 */
export type RecordedWireMessage = {
  id: number;
  section: string;
  method: string;
  tag: string;
  message: string;
  json: string;
};

/** Bytes and big integers as JSON keeps them. */
const plain = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? toHex(value) : typeof value === 'bigint' ? value.toString() : value;

/** Records a call's message read by `schema`, or gives null for the library's own frames and data that is no frame. */
export function recordMessage<H, T extends Sections>(
  schema: Schema<H, T>,
  data: Uint8Array | ArrayBuffer,
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
  const { id, section, method, message, decoded } = recorded;
  return { id, section, method, tag: decoded.tag, message: toHex(message), json: JSON.stringify(decoded, plain) };
}

/** The recorded messages of `method`, decoded with it. */
export function messagesOf<H, T extends Sections, M>(
  schema: Schema<H, T>,
  method: AnyMethod & { readonly message: Codec<M> },
  recorded: readonly RecordedWireMessage[],
): M[] {
  const address = schema.addressOf(method);
  // Read as the method's own codec, so the messages come back typed by it.
  const codec: Codec<M> = method.message;
  return recorded
    .filter(message => message.section === address.section && message.method === address.method)
    .map(message => codec.dec(fromHex(message.message)));
}
