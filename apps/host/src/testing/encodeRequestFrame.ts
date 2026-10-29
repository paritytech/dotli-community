// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { encodeWireMessage, MESSAGE_TYPE_REQUEST } from '@parity/truapi';

type Params = {
  requestId: string;
  /** The trait and method the frame asks. */
  method: { trait: number; method: number };
  /** The encoded request. */
  value: Uint8Array;
};

/** The request frame `requestId` of `method`. Throws when the frame does not encode. */
export function encodeRequestFrame({ requestId, method, value }: Params): Uint8Array {
  const frame = encodeWireMessage({
    requestId,
    payload: { traitId: method.trait, methodId: method.method, messageType: MESSAGE_TYPE_REQUEST, value },
  });
  if (frame.isErr()) {
    throw frame.error;
  }
  return frame.value;
}
