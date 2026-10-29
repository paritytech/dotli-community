// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { scale, VersionedHostRequestLoginError, VersionedHostRequestLoginResponse } from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import { encodeResponseFrame } from './encodeResponseFrame.js';

/** How the core answers a login: a success value, a domain error's reason, a host failure or a cancel. */
type LoginResult =
  | { kind: 'success'; value: 'Success' | 'AlreadyConnected' | 'Rejected' }
  | { kind: 'domain'; reason: string }
  | { kind: 'hostFailure'; reason: string }
  | { kind: 'cancelled' };

// Codec 2 legs carry Result outside and the version wrapper inside.
const loginResponseCodec = scale.Result(
  VersionedHostRequestLoginResponse,
  scale.CallError(VersionedHostRequestLoginError),
);

/** Encodes the core's answer to the login request `requestId`. Throws when the frame does not encode. */
export function buildLoginResponseFrame(requestId: string, result: LoginResult): Uint8Array {
  return encodeResponseFrame({
    requestId,
    method: ACCOUNT_REQUEST_LOGIN,
    value: loginResponseCodec.enc(buildLoginResponse(result)),
  });
}

function buildLoginResponse(result: LoginResult): Parameters<typeof loginResponseCodec.enc>[0] {
  switch (result.kind) {
    case 'success':
      return { success: true, value: { tag: 'V1', value: result.value } };
    case 'domain':
      return {
        success: false,
        value: { tag: 'Domain', value: { tag: 'V1', value: { tag: 'Unknown', value: { reason: result.reason } } } },
      };
    case 'hostFailure':
      return { success: false, value: { tag: 'HostFailure', value: { reason: result.reason } } };
    case 'cancelled':
      return { success: false, value: { tag: 'Cancelled' } };
  }
}
