// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads a relayed frame's header without decoding it, and the body of a phone-bound request.

import { getKeys, isRecord } from '@dotli/shared';
import { compact } from '@parity/truapi/scale';
import { PHONE_METHODS, type PhoneMethod } from './phoneMethods.js';

type FrameHeader = {
  requestId: string;
  /** Undefined for a method that does not go to the phone. */
  method: PhoneMethod | undefined;
  messageType: number;
};

const METHOD_AT = new Map<number, PhoneMethod>(
  getKeys(PHONE_METHODS).map(method => {
    const { ids } = PHONE_METHODS[method];
    return [(ids.trait << 8) | ids.method, method];
  }),
);

const UTF8 = new TextDecoder();

/** The bytes of a SCALE compact prefix by its mode, the low two bits. The big-integer mode never prefixes a frame. */
const COMPACT_PREFIX_BYTES = [1, 2, 4] as const;

/**
 * A frame's header without copying its payload: `[requestId: compact length + UTF-8][trait][method][messageType]`.
 * Undefined for a frame too short to have one, which the core reports itself since the tap is passive.
 */
export function peekFrameHeader(message: Uint8Array): FrameHeader | undefined {
  const first = message[0];
  const prefix = first === undefined ? undefined : COMPACT_PREFIX_BYTES[first & 0b11];
  if (prefix === undefined || message.length < prefix) {
    return undefined;
  }
  // A copy of the prefix only, as the codec reads from the start of a view's whole buffer.
  const end = prefix + Number(compact.dec(message.slice(0, prefix)));
  const traitId = message[end];
  const methodId = message[end + 1];
  const messageType = message[end + 2];
  if (traitId === undefined || methodId === undefined || messageType === undefined) {
    return undefined;
  }
  return {
    requestId: UTF8.decode(message.subarray(prefix, end)),
    method: METHOD_AT.get((traitId << 8) | methodId),
    messageType,
  };
}

/** The unwrapped V1 body of a `method` request's payload. Throws when it does not decode or is another version. */
export function decodePhoneRequestBody(method: PhoneMethod, payload: Uint8Array): unknown {
  const versioned = PHONE_METHODS[method].request.dec(payload);
  const version = isRecord(versioned) ? versioned['tag'] : undefined;
  if (!isRecord(versioned) || version !== 'V1') {
    throw new Error(`unsupported request version ${String(version)}`);
  }
  return versioned['value'];
}
