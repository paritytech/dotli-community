// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { PHONE_METHODS, type PhoneMethod } from '../features/signing/phoneMethods.js';
import { encodeRequestFrame } from './encodeRequestFrame.js';

type Params = {
  requestId: string;
  method: PhoneMethod;
  /** The method's request value. */
  body: unknown;
  /** The envelope version to send it at, the method's newest when absent. */
  version?: string;
};

/** A request frame carrying `body` as the method's request. Throws when the frame does not encode. */
export function encodePhoneRequestFrame({ requestId, method, body, version }: Params): Uint8Array {
  const { ids, request, version: newest } = PHONE_METHODS[method];
  return encodeRequestFrame({ requestId, method: ids, value: request.enc({ tag: version ?? newest, value: body }) });
}
