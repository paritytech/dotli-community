// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One login request over a connection of the page core, answered by the core's login response.

import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginRequest,
  VersionedHostRequestLoginResponse,
  type HostRequestLoginResponse as LoginResponse,
  type WireProvider as Provider,
} from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import { createReporter, defineCount } from '@dotli/metrics';
import { toError } from '@dotli/shared';
import { LoginRequestError } from './loginRequestError.js';

const report = createReporter({ flow: 'wallet' });

/**
 * A frame on the topbar login's own connection that the login skipped and survived. Tagged `outcome` (error) and
 * `reason` (`undecodable_frame`, a frame that did not decode, counted once per login).
 */
const walletLoginFrameMetric = defineCount<'error'>('wallet.login_frame');

type Params = {
  /** What the core shows the user as the login's purpose. None by default. */
  reason?: string | undefined;
};

let topbarLoginRequestCount = 0;

/**
 * Sends one login request over `core` and resolves with the core's login response. Rejects with a `LoginRequestError`
 * when the core refuses the login, and with an error when the request does not encode, the send throws, the answer
 * does not decode or the connection closes.
 */
export function requestCoreLogin(core: Provider, { reason }: Params = {}): Promise<LoginResponse> {
  const requestId = `dotli:topbar-login:${String(++topbarLoginRequestCount)}`;
  const responseCodec = scale.Result(
    VersionedHostRequestLoginResponse,
    scale.CallError(VersionedHostRequestLoginError),
  );
  const frame = encodeWireMessage({
    requestId,
    payload: {
      traitId: ACCOUNT_REQUEST_LOGIN.trait,
      methodId: ACCOUNT_REQUEST_LOGIN.method,
      messageType: MESSAGE_TYPE_REQUEST,
      value: VersionedHostRequestLoginRequest.enc({
        tag: 'V1',
        value: reason === undefined ? {} : { reason },
      }),
    },
  });
  if (frame.isErr()) {
    return Promise.reject(frame.error);
  }

  return new Promise<LoginResponse>((resolve, reject) => {
    let settled = false;
    let reportedUndecodable = false;
    let cleanupRequested = false;
    let unsubscribeMessage: (() => void) | undefined;
    let unsubscribeClose: (() => void) | undefined;

    function unsubscribeAll(): void {
      cleanupRequested = true;
      unsubscribeMessage?.();
      unsubscribeMessage = undefined;
      unsubscribeClose?.();
      unsubscribeClose = undefined;
    }

    function registerCleanup(
      unsubscribe: (() => void) | undefined,
      retain: (value: (() => void) | undefined) => void,
    ): void {
      if (cleanupRequested) {
        unsubscribe?.();
      } else {
        retain(unsubscribe);
      }
    }

    function rejectRequest(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribeAll();
      reject(error);
    }

    function resolveRequest(response: LoginResponse): void {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribeAll();
      resolve(response);
    }

    registerCleanup(
      core.subscribe(message => {
        const decoded = decodeWireMessage(message);
        if (decoded.isErr()) {
          // Every frame the core sends this connection lands here, so one that does not decode is not this answer.
          // The connection is the login's alone, so it is a protocol fault, reported once per request.
          if (!reportedUndecodable) {
            reportedUndecodable = true;
            report.expected(decoded.error, {
              step: 'login_frame',
              metric: walletLoginFrameMetric,
              reason: 'undecodable_frame',
              message: '[dot.li login] ignored a frame that does not decode:',
            });
          }
          return;
        }
        const { payload } = decoded.value;
        if (
          decoded.value.requestId !== requestId ||
          payload.traitId !== ACCOUNT_REQUEST_LOGIN.trait ||
          payload.methodId !== ACCOUNT_REQUEST_LOGIN.method ||
          payload.messageType !== MESSAGE_TYPE_RESPONSE
        ) {
          return;
        }
        try {
          const result = responseCodec.dec(payload.value);
          if (result.success) {
            resolveRequest(result.value.value);
          } else {
            rejectRequest(new LoginRequestError(result.value));
          }
        } catch (error) {
          rejectRequest(new Error('The login answer did not decode', { cause: error }));
        }
      }),
      unsubscribe => {
        unsubscribeMessage = unsubscribe;
      },
    );

    registerCleanup(
      core.subscribeClose?.(error => {
        rejectRequest(error);
      }),
      unsubscribe => {
        unsubscribeClose = unsubscribe;
      },
    );

    try {
      core.postMessage(frame.value);
    } catch (error) {
      rejectRequest(toError(error));
    }
  });
}
