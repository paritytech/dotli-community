// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toHex } from '@dotli/shared';
import type { Schema, Sections } from '../defineSchema.js';
import { FrameRefusedError } from './frameRefusedError.js';
import { readFrame, type RecordedFrame } from './readFrame.js';

/**
 * A call's message as a recording keeps it: by its method's names and tag, with its bytes as hex, and as JSON with
 * bytes as hex, so a page can match it.
 */
export type RecordedWireMessage = {
  id: number;
  section: string;
  method: string;
  tag: string;
  message: string;
  json: string;
};

/** Records a call's message read by `schema`, or gives null for the library's own frames and data that is no frame. */
export function recordMessage<Hello, T extends Sections>(
  schema: Schema<Hello, T>,
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
  return { id, section, method, tag: decoded.tag, message: toHex(message), json: JSON.stringify(decoded, toPlainJson) };
}

/** Bytes and big integers as JSON keeps them. */
function toPlainJson(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? toHex(value) : typeof value === 'bigint' ? value.toString() : value;
}
