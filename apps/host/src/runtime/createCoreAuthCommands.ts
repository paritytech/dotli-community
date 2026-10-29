// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's login, logout and cancel, run on the page core. A login reports its own failures, and session state
// hears what the core could not say for itself. A logout runs the end it is given through the commands' queue.

import { captureException, recordExpected } from '@dotli/metrics';
import { createDeferred, getErrorMessage, log, type ReadableStore } from '@dotli/shared';
import {
  CANCELLED,
  createAuthCommands,
  FAILED,
  type CoreLoginParams,
  type LoginOutcome,
} from './createAuthCommands.js';
import { CoreRedialError } from './coreRedialError.js';
import type { PageCore } from './createPageCore.js';
import { LoginRequestError } from './loginRequestError.js';
import { ownCoreConnection } from './ownCoreConnection.js';
import { requestCoreLogin } from './requestCoreLogin.js';
import type { HostCoreStorage } from './session/createCoreStorage.js';
import type { SessionState } from './session/createSessionState.js';
import type { DotliAuthState } from './session/types.js';
import type { WalletMode } from './state/walletModeState.js';

type Params = {
  /** The page's auth state, which tells how a login ended. */
  auth: ReadableStore<DotliAuthState>;
  core: Pick<PageCore, 'acquire' | 'cancelPairing'>;
  session: Pick<SessionState, 'reportLoginFailure'>;
  /** A local wallet core keeps its session in memory, so its login stores nothing. */
  walletMode: () => WalletMode;
  /** The page's copy, which holds the session a pairing stored, or hears that its write failed. */
  storedSession: Pick<HostCoreStorage, 'readSession' | 'subscribeStoredSession' | 'subscribeSessionWriteFailures'>;
};

type RequestTopbarLoginParams = {
  /** What the core shows the user as the login's purpose, when the topbar names one. */
  reason: string | undefined;
  /** Aborts once a cancel or a logout ends the round. */
  signal: AbortSignal;
  /** Told once the core answered the request, so a state reported since is the core's word on this login. */
  answered: () => void;
};

/** Returns the topbar's login, logout and cancel on the page core. Never throws. */
export function createCoreAuthCommands({ auth, core, session, walletMode, storedSession }: Params) {
  async function login({ reason, signal }: CoreLoginParams): Promise<LoginOutcome> {
    log.event('login requested', { flow: 'wallet' });
    // Before the request, so a failed write of the session it pairs is heard even when it comes first.
    const signIn = watchSignIn(signal);
    try {
      try {
        if (!(await requestTopbarLogin({ reason, signal, answered: signIn.answered }))) {
          log.event('login cancelled before pairing', { flow: 'wallet' });
          return CANCELLED;
        }
      } catch (error) {
        captureLoginFailure(error);
        // The core already rendered a `LoginRequestError`, or stayed silent on purpose. Report a failure
        // only when it never saw one.
        if (!(error instanceof LoginRequestError)) {
          session.reportLoginFailure(getErrorMessage(error));
        }
        if (error instanceof LoginRequestError && error.error.tag === 'Cancelled') {
          return CANCELLED;
        }
        return FAILED;
      }
      const outcome = await signIn.complete();
      log.event('login completed', { flow: 'wallet', outcome: outcome.kind });
      return outcome;
    } finally {
      signIn.stop();
    }
  }

  /** Whether the page's copy holds a session, where a failed read counts as none. */
  async function hasSessionCopy(): Promise<boolean> {
    const read = await storedSession.readSession();
    return read.status === 'ok' && read.blob !== null;
  }

  /**
   * Answers how a login's sign-in ended at `state`, or null while it goes on. A failure or a sign-out ends it only once
   * the state moved on from `answered`, the state when the core answered the request.
   */
  async function readSignInOutcome(state: DotliAuthState, answered: DotliAuthState): Promise<LoginOutcome | null> {
    switch (state.tag) {
      case 'LoginFailed':
        return state === answered ? null : FAILED;
      case 'Disconnected':
        return state === answered ? null : CANCELLED;
      case 'Connected':
        // A local wallet core keeps its session in memory, so nothing is stored for it.
        if (walletMode() === 'local' || (await hasSessionCopy())) {
          return { kind: 'paired', account: state.session };
        }
        return null;
      case 'Restoring':
      case 'Unreachable':
      case 'Pairing':
      case 'Authenticating':
        return null;
    }
  }

  /**
   * Hears a login's sign-in complete: the core reported the account signed in and, for a paired core, the page's copy
   * holds a session. The core may report before its write lands, and the order is its own, so each is checked again
   * on every change of either. The core's own end of the login after its answer, a failure or a sign-out, answers
   * failed or cancelled. A write of the session that failed meanwhile rejects, and a round that ended answers
   * cancelled.
   */
  function watchSignIn(signal: AbortSignal) {
    let failure: { error: unknown } | null = null;
    let whenAnswered: DotliAuthState | null = null;
    let woken = createDeferred<undefined>();

    function nudge(): void {
      woken.resolve(undefined);
    }

    function markAnswered(): void {
      whenAnswered = auth.get();
    }

    const stops = [
      storedSession.subscribeSessionWriteFailures(error => {
        failure ??= { error };
        woken.resolve(undefined);
      }),
      storedSession.subscribeStoredSession(nudge),
      auth.subscribe(nudge),
    ];
    signal.addEventListener('abort', nudge);
    return {
      /** The request answered, so a state reported since is the core's word on this login. Never throws. */
      answered: markAnswered,
      /** Answers how the sign-in ended. Rejects when a write of the session failed meanwhile. */
      async complete(): Promise<LoginOutcome> {
        const answered = whenAnswered ?? auth.get();
        for (;;) {
          woken = createDeferred<undefined>();
          if (failure !== null) {
            throw new Error('The paired session could not be stored', { cause: failure.error });
          }
          if (signal.aborted) {
            return CANCELLED;
          }
          const outcome = await readSignInOutcome(auth.get(), answered);
          if (outcome !== null) {
            return outcome;
          }
          await woken.promise;
        }
      },
      /** Stops hearing the store, the auth state and the round's end. Never throws. */
      stop(): void {
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
  async function requestTopbarLogin({ reason, signal, answered }: RequestTopbarLoginParams): Promise<boolean> {
    // Read after each wait, since a cancel or a logout can end the round during any of them.
    const hasEnded = (): boolean => signal.aborted;
    const lease = await core.acquire();
    try {
      if (hasEnded()) {
        return false;
      }
      const connection = ownCoreConnection(await lease.connect());
      try {
        if (hasEnded()) {
          return false;
        }
        await requestCoreLogin(connection, { reason });
        answered();
        return true;
      } finally {
        connection.dispose();
      }
    } finally {
      lease.release();
    }
  }

  function cancelPairing(): void {
    log.event('pairing cancelled', { flow: 'wallet' });
    core.cancelPairing();
  }

  return createAuthCommands({ auth, login, cancelPairing });
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
