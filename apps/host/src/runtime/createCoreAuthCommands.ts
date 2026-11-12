// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's login, logout and cancel, run on the page core. A login reports its own failures, and session state
// hears what the core could not say for itself. A logout runs the end it is given through the commands' queue.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  getErrorMessage,
  getErrorName,
  listen,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import {
  CANCELLED,
  createAuthCommands,
  FAILED,
  type CoreLoginParams,
  type LoginOutcome,
} from './createAuthCommands.js';
import { CoreRedialError } from './coreRedialError.js';
import type { CoreConnection, CoreLease, PageCore } from './createPageCore.js';
import { LoginRequestError } from './loginRequestError.js';
import { ownCoreConnection, type CoreProvider } from './ownCoreConnection.js';
import { requestCoreLogin } from './requestCoreLogin.js';
import type { HostCoreStorage } from './session/createCoreStorage.js';
import { authViews } from './session/authViews.js';
import type { SessionState } from './session/createSessionState.js';
import type { DotliAuthState } from './session/types.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. A login on the page core failed. Tagged `outcome` (error) and `reason`: the core's refusal tag for a
 * `LoginRequestError`, else the error's name. A cancel, a deny and a redial the page core gave up on are expected,
 * the rest captured.
 */
const walletLoginMetric = defineCount<'error'>('wallet.login');

/** A topbar login's transition that threw. Tagged `outcome` (error). */
const coreLoginTransitionMetric = defineCount<'error'>('core_login.transition');

type Params = {
  /** The page's auth state, which tells how a login ended. */
  auth: ReadableAtom<DotliAuthState>;
  core: Pick<PageCore, 'acquire' | 'cancelPairing'>;
  session: Pick<SessionState, 'reportLoginFailure'>;
  /** A local wallet core keeps its session in memory, so its login stores nothing. */
  isLocalWallet: () => boolean;
  /** The page's copy, which holds the session a pairing stored, or hears that its write failed. */
  storedSession: Pick<HostCoreStorage, 'readSession' | 'subscribeStoredSession' | 'subscribeSessionWriteFailures'>;
};

/**
 * One login and its waiter. `stopWatching` stops hearing the page's copy, the auth state and the round's end, which
 * the login hears from its start, so a failed write of the session it pairs is heard even when it comes first.
 * `writeFailure` is the first such failure.
 */
type CoreLogin = {
  id: symbol;
  reason: CoreLoginParams['reason'];
  signal: CoreLoginParams['signal'];
  resolve: (outcome: LoginOutcome) => void;
  reject: (error: unknown) => void;
  stopWatching: () => void;
  writeFailure: { error: unknown } | null;
};

/**
 * The steps of a login. The request goes over a connection of its own, since the product's connection forwards every
 * frame to the product. `answered` is the auth state when the core answered the request, so a state reported since is
 * the core's word on this login. `judging` reads how the sign-in ended, and `again` holds a change heard meanwhile.
 * `watching` waits for the next change.
 */
type CoreLoginState =
  | { kind: 'idle' }
  | { kind: 'acquiring'; login: CoreLogin }
  | { kind: 'connecting'; login: CoreLogin; lease: CoreLease }
  | { kind: 'requesting'; login: CoreLogin }
  | { kind: 'judging'; login: CoreLogin; answered: DotliAuthState; again: boolean }
  | { kind: 'watching'; login: CoreLogin; answered: DotliAuthState };

type CoreLoginEvent =
  | ({ kind: 'loginAsked' } & CoreLoginParams & Pick<CoreLogin, 'resolve' | 'reject'>)
  | { kind: 'leased'; id: symbol; lease: CoreLease }
  | { kind: 'bootFailed'; id: symbol; error: unknown }
  | { kind: 'connected'; id: symbol; connection: CoreConnection }
  | { kind: 'connectFailed'; id: symbol; error: unknown }
  | { kind: 'requestAnswered'; id: symbol; answered: DotliAuthState }
  | { kind: 'requestFailed'; id: symbol; error: unknown }
  | { kind: 'judged'; id: symbol; outcome: LoginOutcome | null }
  | { kind: 'judgeFailed'; id: symbol; error: unknown }
  | { kind: 'changed'; id: symbol }
  | { kind: 'writeFailed'; id: symbol; error: unknown }
  | { kind: 'roundEnded'; id: symbol };

type CoreLoginEffect =
  | { kind: 'loginRequested' }
  | { kind: 'loginCancelledEarly' }
  | { kind: 'loginCompleted'; outcome: LoginOutcome['kind'] }
  | { kind: 'loginFailed'; error: unknown; tellSession: boolean };

type CoreLoginMachine = MachineTypes<CoreLoginState, CoreLoginEvent, CoreLoginEffect>;

/** One login runs at a time, so a second one is a fault of the caller. */
const refuseSecondLogin: HandlerOf<
  CoreLoginMachine,
  'acquiring' | 'connecting' | 'requesting' | 'judging' | 'watching',
  'loginAsked'
> = (_state, { reject }) => {
  reject(new Error('A topbar login is already under way'));
};

/** A lease that arrives after its login ended is held by nobody, so it goes at once. */
const releaseStaleLease: HandlerOf<CoreLoginMachine, CoreLoginState['kind'], 'leased'> = (_state, { lease }) => {
  lease.release();
};

/**
 * A boot that fails after its login ended is reported here and nowhere else. Session state is not told, since the login
 * already answered.
 */
const reportStaleBootFailure: HandlerOf<CoreLoginMachine, CoreLoginState['kind'], 'bootFailed'> = (
  _state,
  { error },
  { emitSideEffect },
) => {
  emitSideEffect({ kind: 'loginFailed', error, tellSession: false });
};

const recordWriteFailure: HandlerOf<CoreLoginMachine, 'acquiring' | 'connecting' | 'requesting', 'writeFailed'> = (
  state,
  { id, error },
  { emitState },
) => {
  if (id !== state.login.id) {
    return;
  }
  emitState({ ...state, login: withWriteFailure(state.login, error) });
};

/** Returns the topbar's login, logout and cancel on the page core. Never throws. */
export function createCoreAuthCommands({ auth, core, session, isLocalWallet, storedSession }: Params) {
  const machine = createStateMachine<CoreLoginMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        loginAsked(_state, { reason, signal, resolve, reject }, transition) {
          const { emitState, emitSideEffect, update } = transition;
          emitSideEffect({ kind: 'loginRequested' });
          const id = Symbol('topbar login');
          function hearChange(): void {
            update({ kind: 'changed', id });
          }
          const stops = [
            storedSession.subscribeSessionWriteFailures(error => {
              update({ kind: 'writeFailed', id, error });
            }),
            storedSession.subscribeStoredSession(hearChange),
            auth.listen(hearChange),
            listen({
              target: signal,
              type: 'abort',
              handler: () => {
                update({ kind: 'roundEnded', id });
              },
            }),
          ];
          const login: CoreLogin = {
            id,
            reason,
            signal,
            resolve,
            reject,
            stopWatching() {
              for (const stop of stops) {
                stop();
              }
            },
            writeFailure: null,
          };
          // The core's cancel only reaches a pairing already under way, so a round that ended sends nothing.
          if (signal.aborted) {
            answerLogin({ login, outcome: CANCELLED, effect: { kind: 'loginCancelledEarly' } }, transition);
            return;
          }
          emitState({ kind: 'acquiring', login });
          update(
            core.acquire().then(
              lease => ({ kind: 'leased', id, lease }),
              (error: unknown) => ({ kind: 'bootFailed', id, error }),
            ),
          );
        },
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
      },
      acquiring: {
        loginAsked: refuseSecondLogin,
        leased(state, event, transition) {
          const { login } = state;
          if (event.id !== login.id) {
            releaseStaleLease(state, event, transition);
            return;
          }
          const { lease } = event;
          if (login.signal.aborted) {
            answerLogin({ login, outcome: CANCELLED, effect: { kind: 'loginCancelledEarly' } }, transition);
            lease.release();
            return;
          }
          transition.emitState({ kind: 'connecting', login, lease });
          transition.update(
            lease.connect().then(
              connection => ({ kind: 'connected', id: login.id, connection }),
              (error: unknown) => ({ kind: 'connectFailed', id: login.id, error }),
            ),
          );
        },
        bootFailed(state, event, transition) {
          if (event.id !== state.login.id) {
            reportStaleBootFailure(state, event, transition);
            return;
          }
          failLogin(state.login, event.error, transition);
        },
        roundEnded({ login }, { id }, transition) {
          if (id !== login.id) {
            return;
          }
          answerLogin({ login, outcome: CANCELLED, effect: { kind: 'loginCancelledEarly' } }, transition);
        },
        writeFailed: recordWriteFailure,
      },
      connecting: {
        loginAsked: refuseSecondLogin,
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        connected({ login, lease }, { id, connection }, transition) {
          if (id !== login.id) {
            return;
          }
          const provider = ownCoreConnection(connection);
          if (login.signal.aborted) {
            try {
              closeStep(provider, lease);
            } catch (error) {
              failLogin(login, error, transition);
              return;
            }
            answerLogin({ login, outcome: CANCELLED, effect: { kind: 'loginCancelledEarly' } }, transition);
            return;
          }
          transition.emitState({ kind: 'requesting', login });
          transition.update(
            Promise.resolve()
              .then(() => requestCoreLogin(provider, { reason: login.reason }))
              // Read as the core answers, so a state reported since is the core's word on this login.
              .then(() => auth.get())
              .finally(() => {
                closeStep(provider, lease);
              })
              .then(
                answered => ({ kind: 'requestAnswered', id, answered }),
                (error: unknown) => ({ kind: 'requestFailed', id, error }),
              ),
          );
        },
        connectFailed({ login, lease }, { id, error }, transition) {
          if (id !== login.id) {
            return;
          }
          failLogin(login, error, transition);
          lease.release();
        },
        writeFailed: recordWriteFailure,
      },
      requesting: {
        loginAsked: refuseSecondLogin,
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        requestAnswered({ login }, { id, answered }, transition) {
          if (id !== login.id) {
            return;
          }
          judge(login, answered, transition);
        },
        requestFailed({ login }, { id, error }, transition) {
          if (id !== login.id) {
            return;
          }
          failLogin(login, error, transition);
        },
        writeFailed: recordWriteFailure,
      },
      judging: {
        loginAsked: refuseSecondLogin,
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        changed(state, { id }, { emitState }) {
          if (id !== state.login.id) {
            return;
          }
          emitState({ ...state, again: true });
        },
        roundEnded(state, { id }, { emitState }) {
          if (id !== state.login.id) {
            return;
          }
          emitState({ ...state, again: true });
        },
        writeFailed(state, { id, error }, { emitState }) {
          if (id !== state.login.id) {
            return;
          }
          emitState({ ...state, login: withWriteFailure(state.login, error), again: true });
        },
        judged({ login, answered, again }, { id, outcome }, transition) {
          if (id !== login.id) {
            return;
          }
          if (outcome !== null) {
            answerLogin({ login, outcome, effect: { kind: 'loginCompleted', outcome: outcome.kind } }, transition);
            return;
          }
          if (again) {
            judge(login, answered, transition);
            return;
          }
          transition.emitState({ kind: 'watching', login, answered });
        },
        judgeFailed({ login }, { id, error }, transition) {
          if (id !== login.id) {
            return;
          }
          rejectLogin(login, error, transition);
        },
      },
      watching: {
        loginAsked: refuseSecondLogin,
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        changed({ login, answered }, { id }, transition) {
          if (id !== login.id) {
            return;
          }
          judge(login, answered, transition);
        },
        roundEnded({ login, answered }, { id }, transition) {
          if (id !== login.id) {
            return;
          }
          judge(login, answered, transition);
        },
        writeFailed({ login, answered }, { id, error }, transition) {
          if (id !== login.id) {
            return;
          }
          judge(withWriteFailure(login, error), answered, transition);
        },
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'loginRequested':
          report.log.event('login requested');
          return;
        case 'loginCancelledEarly':
          report.log.event('login cancelled before pairing');
          return;
        case 'loginCompleted':
          report.log.event('login completed', { outcome: effect.outcome });
          return;
        case 'loginFailed':
          reportCoreLoginFailure(effect.error);
          if (effect.tellSession) {
            session.reportLoginFailure(getErrorMessage(effect.error));
          }
          return;
      }
    },
    onError(error) {
      report.defect(error, {
        step: 'transition',
        metric: coreLoginTransitionMetric,
        message: '[dot.li wallet] A topbar login transition threw',
      });
    },
  });

  function login({ reason, signal }: CoreLoginParams): Promise<LoginOutcome> {
    return new Promise<LoginOutcome>((resolve, reject) => {
      machine.update({ kind: 'loginAsked', reason, signal, resolve, reject });
    });
  }

  /**
   * Answers how the sign-in ended once it did: the core reported the account signed in and, for a paired core, the
   * page's copy holds a session. The core may report before its write lands, and the order is its own, so each change
   * of either judges again. A write of the session that failed, or a failed read of it, rejects, and a round that ended
   * answers cancelled.
   */
  function judge(login: CoreLogin, answered: DotliAuthState, transition: Transition<CoreLoginMachine>): void {
    if (login.writeFailure !== null) {
      rejectLogin(
        login,
        new Error('The paired session could not be stored', { cause: login.writeFailure.error }),
        transition,
      );
      return;
    }
    if (login.signal.aborted) {
      answerLogin({ login, outcome: CANCELLED, effect: { kind: 'loginCompleted', outcome: 'cancelled' } }, transition);
      return;
    }
    transition.emitState({ kind: 'judging', login, answered, again: false });
    transition.update(
      readSignInOutcome(auth.get(), answered).then(
        outcome => ({ kind: 'judged', id: login.id, outcome }),
        (error: unknown) => ({ kind: 'judgeFailed', id: login.id, error }),
      ),
    );
  }

  /** Whether the page's copy holds a session. Rejects when the read of the copy failed. */
  async function hasSessionCopy(): Promise<boolean> {
    const read = await storedSession.readSession();
    if (read.status === 'failed') {
      throw new Error('The paired session could not be read back', { cause: read.error });
    }
    return read.blob !== null;
  }

  /**
   * Answers how a login's sign-in ended at `state`, or null while it goes on. A failure or a sign-out ends it only once
   * the state moved on from `answered`, the state when the core answered the request. Rejects when the read of the
   * page's copy failed. A failed login is told apart before an idle one, since a failed login is idle too.
   */
  async function readSignInOutcome(state: DotliAuthState, answered: DotliAuthState): Promise<LoginOutcome | null> {
    const account = authViews.getSignedInSession(state);
    if (account !== null) {
      // A local wallet core keeps its session in memory, so nothing is stored for it.
      if (isLocalWallet() || (await hasSessionCopy())) {
        return { kind: 'paired', account };
      }
      return null;
    }
    switch (authViews.getLoginStep(state)?.step) {
      case 'failed':
        return state === answered ? null : FAILED;
      case 'pairing':
      case 'authenticating':
        return null;
      case undefined:
        break;
    }
    if (authViews.isSignInIdle(state)) {
      return state === answered ? null : CANCELLED;
    }
    return null;
  }

  function cancelPairing(): void {
    report.log.event('pairing cancelled');
    core.cancelPairing();
  }

  return createAuthCommands({ auth, login, cancelPairing });
}

/** Ends the login with `outcome`, after `effect`. */
function answerLogin(
  { login, outcome, effect }: { login: CoreLogin; outcome: LoginOutcome; effect: CoreLoginEffect },
  { emitState, emitSideEffect }: Transition<CoreLoginMachine>,
): void {
  emitState({ kind: 'idle' });
  emitSideEffect(effect);
  login.stopWatching();
  login.resolve(outcome);
}

function rejectLogin(login: CoreLogin, error: unknown, { emitState }: Transition<CoreLoginMachine>): void {
  emitState({ kind: 'idle' });
  login.stopWatching();
  login.reject(error);
}

/**
 * Ends the login with a failure. The core already rendered a `LoginRequestError`, or stayed silent on purpose, so
 * session state hears only a failure the core never saw.
 */
function failLogin(login: CoreLogin, error: unknown, transition: Transition<CoreLoginMachine>): void {
  const refused = error instanceof LoginRequestError;
  answerLogin(
    {
      login,
      outcome: refused && error.error.tag === 'Cancelled' ? CANCELLED : FAILED,
      effect: { kind: 'loginFailed', error, tellSession: !refused },
    },
    transition,
  );
}

function withWriteFailure(login: CoreLogin, error: unknown): CoreLogin {
  return { ...login, writeFailure: login.writeFailure ?? { error } };
}

/** Closes the login's connection, then lets the core go even when the close throws. Throws what either threw. */
function closeStep(connection: Pick<CoreProvider, 'dispose'>, lease: Pick<CoreLease, 'release'>): void {
  try {
    connection.dispose();
  } finally {
    lease.release();
  }
}

/**
 * A cancelled or denied login is an outcome, not a fault, and the page core already captured a redial it gave up on.
 * The core's other refusals are still reported.
 */
function reportCoreLoginFailure(error: unknown): void {
  const reason = error instanceof LoginRequestError ? error.error.tag : (getErrorName(error) ?? 'unknown');
  if (
    error instanceof CoreRedialError ||
    (error instanceof LoginRequestError && (error.error.tag === 'Cancelled' || error.error.tag === 'Denied'))
  ) {
    report.expected(error, { step: 'login', metric: walletLoginMetric, reason });
    return;
  }
  report.defect(error, {
    step: 'login',
    ...(error instanceof LoginRequestError ? { tags: { login_error: error.error.tag } } : {}),
    metric: walletLoginMetric,
    message: '[dot.li wallet] login failed:',
    reason,
  });
}
