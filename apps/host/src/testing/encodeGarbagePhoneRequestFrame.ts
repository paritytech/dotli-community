// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { PHONE_METHODS, type PhoneMethod } from '../runtime/phoneMethods.js';
import { encodeRequestFrame } from './encodeRequestFrame.js';

/** A request frame at `method`'s address whose body is not a request. Throws when the frame does not encode. */
export function encodeGarbagePhoneRequestFrame(requestId: string, method: PhoneMethod): Uint8Array {
  return encodeRequestFrame({
    requestId,
    method: PHONE_METHODS[method].ids,
    value: new Uint8Array([0xff, 0xff, 0xff]),
  });
}
