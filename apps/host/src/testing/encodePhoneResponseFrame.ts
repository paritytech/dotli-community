// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CallErrorValue } from '@parity/truapi/scale';
import { PHONE_METHODS, type PhoneMethod } from '../runtime/phoneMethods.js';
import { encodeResponseFrame } from './encodeResponseFrame.js';

/** How the phone answered: the method's V1 response, its V1 domain error, or a call error as it is. */
export type PhoneResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'domain'; value: unknown }
  | { kind: 'error'; error: CallErrorValue<unknown> };

type Params = {
  requestId: string;
  method: PhoneMethod;
  result: PhoneResult;
};

/** A response frame for `result`. Throws when the frame does not encode. */
export function encodePhoneResponseFrame({ requestId, method, result }: Params): Uint8Array {
  const { ids, response } = PHONE_METHODS[method];
  return encodeResponseFrame({ requestId, method: ids, value: response.enc(buildResponsePayload(result)) });
}

function buildResponsePayload(result: PhoneResult) {
  switch (result.kind) {
    case 'ok':
      return { success: true as const, value: { tag: 'V1', value: result.value } };
    case 'domain':
      return { success: false as const, value: { tag: 'Domain' as const, value: { tag: 'V1', value: result.value } } };
    case 'error':
      return { success: false as const, value: result.error };
  }
}
