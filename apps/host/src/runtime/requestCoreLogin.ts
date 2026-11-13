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
    const unsubscribes: (() => void)[] = [];

    /** Keeps `unsubscribe` until the request settles, or runs it at once when a subscribe heard the answer already. */
    function hold(unsubscribe: (() => void) | undefined): void {
      if (unsubscribe === undefined) {
        return;
      }
      if (settled) {
        unsubscribe();
        return;
      }
      unsubscribes.push(unsubscribe);
    }

    // The promise settles once by itself, so only the listeners need a latch.
    function stop(): void {
      settled = true;
      for (const unsubscribe of unsubscribes.splice(0)) {
        unsubscribe();
      }
    }

    hold(
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
        let result: ReturnType<typeof responseCodec.dec>;
        try {
          result = responseCodec.dec(payload.value);
        } catch (error) {
          stop();
          reject(new Error('The login answer did not decode', { cause: error }));
          return;
        }
        stop();
        if (result.success) {
          resolve(result.value.value);
        } else {
          reject(new LoginRequestError(result.value));
        }
      }),
    );
    hold(
      core.subscribeClose?.(error => {
        stop();
        reject(error);
      }),
    );

    try {
      core.postMessage(frame.value);
    } catch (error) {
      stop();
      reject(toError(error));
    }
  });
}
