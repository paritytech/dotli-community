// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toError } from '@dotli/shared';
import type { Schema, Sections } from '../defineSchema.js';
import type { Failure } from '../failure.js';
import { frameCodec, type Frame } from '../frame.js';
import type { HandshakeOffer, HandshakeResponse } from '../handshakeCodecs.js';
import type { MessageBytes } from '../messageBytes.js';
import { FrameRefusedError } from './frameRefusedError.js';

/**
 * A frame as a test reads it. A call keeps its message's bytes, and the message as its method decoded it, read by its
 * tag. A call to a method the schema lacks is named by its numeric ids, with no decoded message.
 */
export type RecordedFrame =
  | { id: number; kind: 'handshakeOffer'; value: HandshakeOffer }
  | { id: number; kind: 'handshakeResponse'; value: HandshakeResponse }
  | { id: number; kind: 'failed'; value: Failure }
  | {
      id: number;
      kind: 'call';
      section: string;
      method: string;
      message: MessageBytes;
      decoded: { tag: string } | null;
    };

/**
 * Reads a recorded frame: bytes a provider delivered, or a buffer posted between documents. Throws a
 * `FrameRefusedError` on data that is no frame.
 */
export function readFrame<Hello, T extends Sections>(
  schema: Schema<Hello, T>,
  data: Uint8Array | ArrayBuffer,
): RecordedFrame {
  let frame: Frame<MessageBytes>;
  try {
    frame = frameCodec.dec(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  } catch (error) {
    throw new FrameRefusedError(toError(error));
  }
  const { id, body } = frame;
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
      let decoded: { tag: string };
      try {
        decoded = method.message.dec(message);
      } catch (error) {
        throw new FrameRefusedError(toError(error));
      }
      return { id, kind: 'call', section, method: name, message, decoded };
    }
  }
}
