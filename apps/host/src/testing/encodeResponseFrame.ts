// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { encodeWireMessage, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';

type Params = {
  requestId: string;
  /** The trait and method the frame answers. */
  method: { trait: number; method: number };
  /** The encoded answer. */
  value: Uint8Array;
};

/** The response frame for request `requestId` of `method`. Throws when the frame does not encode. */
export function encodeResponseFrame({ requestId, method, value }: Params): Uint8Array {
  const frame = encodeWireMessage({
    requestId,
    payload: { traitId: method.trait, methodId: method.method, messageType: MESSAGE_TYPE_RESPONSE, value },
  });
  if (frame.isErr()) {
    throw frame.error;
  }
  return frame.value;
}
