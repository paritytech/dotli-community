// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { PHONE_METHODS, type PhoneMethod } from '../runtime/phoneMethods.js';
import { encodeRequestFrame } from './encodeRequestFrame.js';

type Params = {
  requestId: string;
  method: PhoneMethod;
  /** The method's V1 request value. */
  body: unknown;
};

/** A request frame carrying `body` as the method's V1 request. Throws when the frame does not encode. */
export function encodePhoneRequestFrame({ requestId, method, body }: Params): Uint8Array {
  const { ids, request } = PHONE_METHODS[method];
  return encodeRequestFrame({ requestId, method: ids, value: request.enc({ tag: 'V1', value: body }) });
}
