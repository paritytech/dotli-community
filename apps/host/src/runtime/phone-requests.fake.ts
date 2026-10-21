// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import { encodeWireMessage, MESSAGE_TYPE_REQUEST, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import type { CallErrorValue } from '@parity/truapi/scale';
import { PHONE_METHODS, type PhoneMethod } from './phone-methods.js';

/** A V1 `signRaw` request body of the product's first account. */
export const SIGN_RAW_BODY = {
  account: { dotNsIdentifier: 'product.dot', derivationIndex: { tag: 'Index', value: 0 } },
  payload: { tag: 'Payload', value: { payload: 'x' } },
};

function frame(requestId: string, method: PhoneMethod, messageType: number, value: Uint8Array): Uint8Array {
  const { ids } = PHONE_METHODS[method];
  const encoded = encodeWireMessage({
    requestId,
    payload: { traitId: ids.trait, methodId: ids.method, messageType, value },
  });
  if (encoded.isErr()) {
    throw encoded.error;
  }
  return encoded.value;
}

/** A request frame carrying `body` as the method's V1 request. */
export function requestFrame(requestId: string, method: PhoneMethod, body: unknown): Uint8Array {
  return frame(requestId, method, MESSAGE_TYPE_REQUEST, PHONE_METHODS[method].request.enc({ tag: 'V1', value: body }));
}

/**
 * A response frame for `result`. An `ok` value is the method's V1 response and a `domain` value its V1 error,
 * and any other `error` is a call error as it is.
 */
export function responseFrame(
  requestId: string,
  method: PhoneMethod,
  result: { ok: unknown } | { domain: unknown } | { error: CallErrorValue<unknown> },
): Uint8Array {
  const payload =
    'ok' in result
      ? { success: true as const, value: { tag: 'V1', value: result.ok } }
      : {
          success: false as const,
          value:
            'domain' in result ? { tag: 'Domain' as const, value: { tag: 'V1', value: result.domain } } : result.error,
        };
  return frame(requestId, method, MESSAGE_TYPE_RESPONSE, PHONE_METHODS[method].response.enc(payload));
}

/** A request frame at `method`'s address whose body is not a request. */
export function garbageRequestFrame(requestId: string, method: PhoneMethod): Uint8Array {
  return frame(requestId, method, MESSAGE_TYPE_REQUEST, new Uint8Array([0xff, 0xff, 0xff]));
}
