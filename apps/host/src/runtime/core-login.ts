// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's login, logout and cancel, run on the page core. Login and logout share one queue, so overlapping calls
// never reach the core twice. Each reports its own failures, and session state hears what the core could not say for
// itself.

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
import { captureException, m, recordExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, log, type ReadableStore } from '@dotli/shared';
import { wrapCoreProviderForDebug } from './core-connection.js';
import type { DotliAuthState } from './session/auth-state.js';
import type { SessionState } from './session/session-state.js';
import { isLoginActive } from './state/auth.js';
import { LoginRequestError } from './login-request-error.js';
import type { PageCore } from './page-core.js';
import type { WalletMode } from './state/wallet-mode.js';
import type { WalletSwitchOutcome } from './wallet-switch.js';

export interface AuthCommands {
  /** Settles once the login has ended. A no-op while a login is under way or the user is signed in. */
  login(reason?: string): Promise<void>;
  /** Settles once the logout has ended. A no-op once the user is signed out. */
  logout(): Promise<void>;
  /** Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in. */
  cancelLogin(): void;
}

export interface AuthCommandsDeps {
  auth: ReadableStore<DotliAuthState>;
  /** One login to its end, reporting its own failures. */
  login(reason: string | undefined): Promise<void>;
  /** One logout to its end, reporting its own failures. */
  logout(): Promise<void>;
  cancelPairing(): void;
}

const AUTH_POOL = 'auth';

export function createAuthCommands(deps: AuthCommandsDeps): AuthCommands {
  const queue = createAsyncTaskPool({ poolSize: 1 });
  // A login answers every call made in its round, so a click queued behind it starts no second pairing. A round ends
  // when its login ends or when a cancel or logout is asked for, whichever comes first, so a click after either still
  // logs in.
  let round = {};
  return {
    login(reason) {
      const asked = round;
      return queue.call(
        async () => {
          if (asked !== round) {
            return;
          }
          try {
            if (!isLoginActive(deps.auth.get())) {
              await deps.login(reason);
            }
          } finally {
            if (round === asked) {
              round = {};
            }
          }
        },
        { pool: AUTH_POOL },
      );
    },
    logout() {
      round = {};
      return queue.call(
        async () => {
          if (deps.auth.get().tag === 'Disconnected') {
            return;
          }
          await deps.logout();
        },
        { pool: AUTH_POOL },
      );
    },
    cancelLogin() {
      round = {};
      deps.cancelPairing();
    },
  };
}

export interface CoreAuthCommandsDeps {
  auth: ReadableStore<DotliAuthState>;
  core: Pick<PageCore, 'acquire' | 'cancelPairing'>;
  session: Pick<SessionState, 'reportLoginFailure' | 'reportLogoutWithoutCore'>;
  walletMode: () => WalletMode;
  /** Leaves local wallet mode, which reloads the page. A failure is reported there and answered as `failed`. */
  leaveLocalWallet: () => Promise<WalletSwitchOutcome>;
}

/** A closed set, so the metric's `reason` tag stays bounded. */
type LogoutFailureReason = 'boot' | 'disconnect';

export function createCoreAuthCommands(deps: CoreAuthCommandsDeps): AuthCommands {
  async function login(reason: string | undefined): Promise<void> {
    log.event('login requested', { flow: 'wallet' });
    try {
      await topbarLogin(reason);
      log.event('login completed', { flow: 'wallet' });
    } catch (error) {
      captureLoginFailure(error);
      // The core already rendered a `LoginRequestError`, or stayed silent on purpose. Report a failure
      // only when it never saw one.
      if (!(error instanceof LoginRequestError)) {
        deps.session.reportLoginFailure(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Over a connection of its own, since the product's connection forwards every frame to the product. */
  async function topbarLogin(reason: string | undefined): Promise<void> {
    const lease = await deps.core.acquire();
    try {
      const core = wrapCoreProviderForDebug(await lease.connect());
      try {
        await requestCoreLogin(core, reason);
      } finally {
        core.dispose();
      }
    } finally {
      lease.release();
    }
  }

  async function logout(): Promise<void> {
    log.event('logout requested', { flow: 'wallet' });
    if (deps.walletMode() === 'local') {
      // A local session lives only in memory, so logging out means leaving local mode. Either outcome ends the
      // logout here: the page reloads, or the switch already reported why it stayed.
      await deps.leaveLocalWallet();
      return;
    }
    await disconnectSession();
  }

  async function disconnectSession(): Promise<void> {
    let lease;
    try {
      lease = await deps.core.acquire();
    } catch (err) {
      reportLogoutFailure(err, 'boot');
      // Keep the UI responsive even though the persisted session could not be cleared.
      deps.session.reportLogoutWithoutCore();
      return;
    }
    try {
      await lease.runtime.disconnectSession();
      m.count(S.WALLET_LOGOUT, { outcome: 'ok' });
    } catch (err) {
      // The auth state stays the core's, which still holds the session, so the badge never claims a logout that failed.
      reportLogoutFailure(err, 'disconnect');
    } finally {
      lease.release();
    }
  }

  return createAuthCommands({
    auth: deps.auth,
    login,
    logout,
    cancelPairing: () => {
      log.event('pairing cancelled', { flow: 'wallet' });
      deps.core.cancelPairing();
    },
  });
}

/** A cancelled or denied login is an outcome, not a fault. The core's other refusals are still reported. */
function captureLoginFailure(error: unknown): void {
  if (error instanceof LoginRequestError && (error.error.tag === 'Cancelled' || error.error.tag === 'Denied')) {
    recordExpected(error, { flow: 'wallet', step: 'login' });
    return;
  }
  captureException(error, {
    flow: 'wallet',
    step: 'login',
    ...(error instanceof LoginRequestError ? { tags: { login_error: error.error.tag } } : {}),
  });
}

function reportLogoutFailure(error: unknown, reason: LogoutFailureReason): void {
  log.error(`[dot.li] logout ${reason} failed:`, error);
  captureException(error, { flow: 'wallet', step: 'logout', tags: { reason } });
  m.count(S.WALLET_LOGOUT, { outcome: 'error', reason });
}

let topbarLoginRequestSeq = 0;

export function requestCoreLogin(core: Provider, reason?: string): Promise<LoginResponse> {
  const requestId = `dotli:topbar-login:${String(++topbarLoginRequestSeq)}`;
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
    let cleanupRequested = false;
    let unsubscribeMessage: (() => void) | undefined;
    let unsubscribeClose: (() => void) | undefined;
    const cleanup = (): void => {
      cleanupRequested = true;
      unsubscribeMessage?.();
      unsubscribeMessage = undefined;
      unsubscribeClose?.();
      unsubscribeClose = undefined;
    };
    const registerCleanup = (
      unsubscribe: (() => void) | undefined,
      retain: (value: (() => void) | undefined) => void,
    ): void => {
      if (cleanupRequested) {
        unsubscribe?.();
      } else {
        retain(unsubscribe);
      }
    };
    const rejectRequest = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveRequest = (response: LoginResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };

    registerCleanup(
      core.subscribe(message => {
        const decoded = decodeWireMessage(message);
        if (decoded.isErr()) {
          rejectRequest(decoded.error);
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
        cleanup();
        try {
          const result = responseCodec.dec(payload.value);
          if (result.success) {
            resolveRequest(result.value.value);
          } else {
            const error = new LoginRequestError(result.value);
            rejectRequest(error);
          }
        } catch (error) {
          rejectRequest(error instanceof Error ? error : new Error(String(error)));
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
      rejectRequest(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
