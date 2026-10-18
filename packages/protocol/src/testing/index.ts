// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a functional test needs to read the protocol frame's traffic in a real page. Never imported by shipped code.

import { fromHex, toHex } from '@dotli/shared';
import type { AnyMethod, Codec } from '@dotli/transport';
import { FrameRefusedError, readFrame, readMessage } from '@dotli/transport/testing';
import { protocolSchema } from '../schema.js';

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

/** Records a call's message the frame sent, or gives null for the library's own frames and data that is no frame. */
export function recordWireMessage(data: ArrayBuffer): RecordedWireMessage | null {
  let frame;
  try {
    frame = readFrame(protocolSchema, data);
  } catch (error) {
    // Data that is no frame is not recorded. Any other throw is a fault.
    if (error instanceof FrameRefusedError) {
      return null;
    }
    throw error;
  }
  if (frame.kind !== 'call' || frame.tag === null) {
    return null;
  }
  const { id, trait, method, tag, message } = frame;
  const placed = [...protocolSchema.addresses].find(
    ([, address]) => address.trait === trait && address.method === method,
  );
  const json = placed === undefined ? 'null' : JSON.stringify(placed[0].message.dec(message), plain);
  return { id, trait, method, tag, message: toHex(message), json };
}

/** The recorded messages of `method`, decoded with it. */
export function messagesOf<M>(
  method: AnyMethod & { readonly message: Codec<M> },
  recorded: readonly RecordedWireMessage[],
): M[] {
  const address = protocolSchema.addresses.get(method);
  return recorded
    .filter(message => message.trait === address?.trait && message.method === address.method)
    .map(message => readMessage(method, fromHex(message.message)));
}
