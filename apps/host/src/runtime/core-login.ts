// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's login, logout and cancel, run on the page core. Login and logout share one queue, so overlapping calls
// never reach the core twice. A login reports its own failures, and session state hears what the core could not say
// for itself. What a logout does is the page's sign-out, which runs its end through this queue.

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
import { captureException, recordExpected, reportExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, deferred, errorMessage, log, type ReadableStore, toError } from '@dotli/shared';
import { ownCoreConnection } from './core-connection.js';
import type { DotliAuthState } from './session/auth-state.js';
import type { HostCoreStorage } from './session/core-storage.js';
import type { SessionState, TruapiSessionUiState } from './session/session-state.js';
import { LoginRequestError } from './login-request-error.js';
import { CoreRedialError, type PageCore } from './page-core.js';
import type { LogoutOutcome } from './sign-out.js';
import type { WalletMode } from './state/wallet-mode.js';

/**
 * How a login ended. `paired` once the core reports the account signed in and, for a pairing, the page's copy holds the
 * session it stored. `failed` was reported where it happened, `cancelled` is a round ended by a cancel or a logout.
 */
export type LoginOutcome =
  { kind: 'paired'; account: TruapiSessionUiState } | { kind: 'failed' } | { kind: 'cancelled' };

const CANCELLED: LoginOutcome = { kind: 'cancelled' };
const FAILED: LoginOutcome = { kind: 'failed' };

/** The page's sign-in and sign-out on its core. */
export type AuthCommands = {
  /**
   * Answers how the login ended. A click queued behind a login shares its answer. Answers `paired` at once for a user
   * already signed in. Rejects when the core paired but its session could not be stored.
   */
  login(reason?: string): Promise<LoginOutcome>;
  /**
   * Settles once the sign-out has ended, having reported its own failures, with whether the phone heard of every
   * session this page held.
   */
  logout(): Promise<LogoutOutcome>;
  /** Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in. */
  cancelLogin(): void;
};

/** Login, logout and cancel on the core, which the page's sign-out runs its end through. */
export type CoreCommands = {
  /**
   * Ends the login round and cancels a pairing under way, since the core may never answer it, then runs `end` once no
   * login is open, in the order logins and logouts were asked for, and answers what it answers. What there is to end
   * is `end`'s to decide.
   */
  logout<T>(end: () => Promise<T>): Promise<T>;
} & Omit<AuthCommands, 'logout'>;

export type AuthCommandsDeps = {
  auth: ReadableStore<DotliAuthState>;
  /**
   * One login to its end, answering how it ended and reporting its own failures. `signal` aborts once a cancel or a
   * logout ends the round, so a login still waiting for its core sends nothing.
   */
  login(reason: string | undefined, signal: AbortSignal): Promise<LoginOutcome>;
  cancelPairing(): void;
};

const AUTH_POOL = 'auth';

/** The calls of one login, which share its answer. */
type LoginRound = {
  readonly controller: AbortController;
  answer: LoginOutcome | null;
};

const newRound = (): LoginRound => ({ controller: new AbortController(), answer: null });

export function createAuthCommands(deps: AuthCommandsDeps): CoreCommands {
  const queue = createAsyncTaskPool({ poolSize: 1 });
  // A login answers every call made in its round, so a click queued behind it starts no second pairing. A round ends
  // when its login ends or when a cancel or logout is asked for, whichever comes first, so a click after either still
  // logs in. Ending a round by cancel or logout aborts it, which a login still waiting for its core hears.
  let round = newRound();
  const endRound = (): void => {
    round.controller.abort(new DOMException('The sign-in was cancelled', 'AbortError'));
    round = newRound();
  };
  return {
    login(reason) {
      const asked = round;
      return queue.call(
        async () => {
          if (asked.answer !== null) {
            return asked.answer;
          }
          if (asked !== round) {
            return CANCELLED;
          }
          try {
            const state = deps.auth.get();
            asked.answer =
              state.tag === 'Connected'
                ? { kind: 'paired', account: state.session }
                : await deps.login(reason, asked.controller.signal);
            return asked.answer;
          } finally {
            if (round === asked) {
              round = newRound();
            }
          }
        },
        { pool: AUTH_POOL },
      );
    },
    logout(end) {
      endRound();
      // The logout queues behind the open login, which only the cancel ends when the core never answers it.
      const { tag } = deps.auth.get();
      if (tag === 'Pairing' || tag === 'Authenticating') {
        deps.cancelPairing();
      }
      return queue.call(end, { pool: AUTH_POOL });
    },
    cancelLogin() {
      endRound();
      deps.cancelPairing();
    },
  };
}

export type CoreAuthCommandsDeps = {
  auth: ReadableStore<DotliAuthState>;
  core: Pick<PageCore, 'acquire' | 'cancelPairing'>;
  session: Pick<SessionState, 'reportLoginFailure'>;
  /** A local wallet core keeps its session in memory, so its login stores nothing. */
  walletMode: () => WalletMode;
  /** The page's copy, which holds the session a pairing stored, or hears that its write failed. */
  storedSession: Pick<HostCoreStorage, 'readSession' | 'onStoredSessionChanged' | 'onSessionWriteFailed'>;
};

export function createCoreAuthCommands(deps: CoreAuthCommandsDeps): CoreCommands {
  async function login(reason: string | undefined, signal: AbortSignal): Promise<LoginOutcome> {
    log.event('login requested', { flow: 'wallet' });
    // Before the request, so a failed write of the session it pairs is heard even when it comes first.
    const signIn = watchSignIn(signal);
    try {
      try {
        if (!(await topbarLogin(reason, signal, signIn.answered))) {
          log.event('login cancelled before pairing', { flow: 'wallet' });
          return CANCELLED;
        }
      } catch (error) {
        captureLoginFailure(error);
        // The core already rendered a `LoginRequestError`, or stayed silent on purpose. Report a failure
        // only when it never saw one.
        if (!(error instanceof LoginRequestError)) {
          deps.session.reportLoginFailure(errorMessage(error));
        }
        return error instanceof LoginRequestError && error.error.tag === 'Cancelled' ? CANCELLED : FAILED;
      }
      const outcome = await signIn.complete();
      log.event('login completed', { flow: 'wallet', outcome: outcome.kind });
      return outcome;
    } finally {
      signIn.stop();
    }
  }

  /** Whether the page's copy holds a session, where a failed read counts as none. */
  async function copyHoldsSession(): Promise<boolean> {
    const read = await deps.storedSession.readSession();
    return read.status === 'ok' && read.blob !== null;
  }

  /**
   * Hears a login's sign-in complete: the core reported the account signed in and, for a paired core, the page's copy
   * holds a session. The core may report before its write lands, and the order is its own, so each is checked again
   * on every change of either. The core's own end of the login after its answer, a failure or a sign-out, answers
   * failed or cancelled. A write of the session that failed meanwhile rejects, and a round that ended answers
   * cancelled.
   */
  function watchSignIn(signal: AbortSignal): {
    /** The request answered, so a state reported since is the core's word on this login. */
    answered: () => void;
    complete(): Promise<LoginOutcome>;
    stop(): void;
  } {
    let failure: { error: unknown } | null = null;
    let whenAnswered: DotliAuthState | null = null;
    let woken = deferred<undefined>();
    const nudge = (): void => {
      woken.resolve(undefined);
    };
    const stops = [
      deps.storedSession.onSessionWriteFailed(error => {
        failure ??= { error };
        woken.resolve(undefined);
      }),
      deps.storedSession.onStoredSessionChanged(nudge),
      deps.auth.subscribe(nudge),
    ];
    signal.addEventListener('abort', nudge);
    return {
      answered: () => {
        whenAnswered = deps.auth.get();
      },
      async complete() {
        const answered = whenAnswered ?? deps.auth.get();
        for (;;) {
          woken = deferred<undefined>();
          if (failure !== null) {
            throw new Error('The paired session could not be stored', { cause: failure.error });
          }
          if (signal.aborted) {
            return CANCELLED;
          }
          const state = deps.auth.get();
          if (state !== answered && state.tag === 'LoginFailed') {
            return FAILED;
          }
          if (state !== answered && state.tag === 'Disconnected') {
            return CANCELLED;
          }
          // A local wallet core keeps its session in memory, so nothing is stored for it.
          if (state.tag === 'Connected' && (deps.walletMode() === 'local' || (await copyHoldsSession()))) {
            return { kind: 'paired', account: state.session };
          }
          await woken.promise;
        }
      },
      stop() {
        for (const stop of stops) {
          stop();
        }
        signal.removeEventListener('abort', nudge);
      },
    };
  }

  /**
   * Over a connection of its own, since the product's connection forwards every frame to the product. False when the
   * round ended before the request went out, since the core's cancel only reaches a pairing already under way.
   */
  async function topbarLogin(reason: string | undefined, signal: AbortSignal, answered: () => void): Promise<boolean> {
    // Read after each wait, since a cancel or a logout can end the round during any of them.
    const ended = (): boolean => signal.aborted;
    const lease = await deps.core.acquire();
    try {
      if (ended()) {
        return false;
      }
      const core = ownCoreConnection(await lease.connect());
      try {
        if (ended()) {
          return false;
        }
        await requestCoreLogin(core, reason);
        answered();
        return true;
      } finally {
        core.dispose();
      }
    } finally {
      lease.release();
    }
  }

  return createAuthCommands({
    auth: deps.auth,
    login,
    cancelPairing: () => {
      log.event('pairing cancelled', { flow: 'wallet' });
      deps.core.cancelPairing();
    },
  });
}

/**
 * A cancelled or denied login is an outcome, not a fault, and the page core already captured a redial it gave up on.
 * The core's other refusals are still reported.
 */
function captureLoginFailure(error: unknown): void {
  if (
    error instanceof CoreRedialError ||
    (error instanceof LoginRequestError && (error.error.tag === 'Cancelled' || error.error.tag === 'Denied'))
  ) {
    recordExpected(error, { flow: 'wallet', step: 'login' });
    return;
  }
  captureException(error, {
    flow: 'wallet',
    step: 'login',
    ...(error instanceof LoginRequestError ? { tags: { login_error: error.error.tag } } : {}),
  });
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
    let reportedUndecodable = false;
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
          // Every frame the core sends this connection lands here, so one that does not decode is not this answer.
          // The connection is the login's alone, so it is a protocol fault, reported once per request.
          if (!reportedUndecodable) {
            reportedUndecodable = true;
            reportExpected(decoded.error, {
              flow: 'wallet',
              step: 'login_frame',
              metric: S.WALLET_LOGIN_FRAME,
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
