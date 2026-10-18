// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toError } from '@dotli/shared';
import type { Codec } from 'scale-ts';
import type { Failure } from '../result.js';
import type { AnyMethod, Schema, Traits } from '../schema.js';
import { decode, frame, type Accept, type Open } from '../wire.js';

export { createProviderPair } from '../provider.fake.js';

/**
 * A frame as a test reads it. A call keeps its message's bytes, which `readMessage` decodes typed with its method, and
 * the message as its method decoded it, read by its tag. A call to a method the schema lacks is named by its numeric
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
      const placed = schema.methodAt(trait, method);
      if (placed === undefined) {
        return { id, kind: 'call', trait: String(trait), method: String(method), message, decoded: null };
      }
      const address = schema.addressOf(placed);
      return {
        id,
        kind: 'call',
        trait: address.trait,
        method: address.method,
        message,
        decoded: decodedBy(placed, message),
      };
    }
  }
}

/** Decodes a recorded call's message with the method it belongs to. */
export function readMessage<M>(method: { readonly message: Codec<M> }, message: Uint8Array): M {
  return method.message.dec(message);
}
