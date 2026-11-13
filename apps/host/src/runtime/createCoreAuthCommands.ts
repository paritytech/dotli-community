// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's login, logout and cancel, run on the page core. A login reports its own failures, and session state
// hears what the core could not say for itself. A logout runs the end it is given through the commands' queue.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createDeferred,
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
import { ownCoreConnection } from './ownCoreConnection.js';
import { readSignInOutcome } from './readSignInOutcome.js';
import { requestCoreLogin } from './requestCoreLogin.js';
import type { HostCoreStorage } from './session/createCoreStorage.js';
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
 * One login and its caller. `stopWatching` stops hearing the page's copy, the auth state and the round's end, which
 * the login hears from its start, so a failed write of the session it pairs is heard even when it comes first.
 * `writeFailure` is the first such failure, and `ended` is whether a cancel or a logout ended the login's round.
 */
type CoreLogin = {
  id: symbol;
  reason: CoreLoginParams['reason'];
  caller: ReturnType<typeof createDeferred<LoginOutcome>>;
  stopWatching: () => void;
  writeFailure: { error: unknown } | null;
  ended: boolean;
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

/**
 * Only the core's boot can outlive its login, since a round's end leaves `acquiring` before the lease comes, so its
 * events carry the login they are for. Every other step leaves only on its own event, and the login stops its
 * listeners as it answers, so their events never reach another login.
 */
type CoreLoginEvent =
  | ({ kind: 'loginAsked' } & CoreLoginParams & Pick<CoreLogin, 'caller'>)
  | { kind: 'leased'; id: symbol; lease: CoreLease }
  | { kind: 'bootFailed'; id: symbol; error: unknown }
  | { kind: 'connected'; connection: CoreConnection }
  | { kind: 'connectFailed'; error: unknown }
  | { kind: 'requestAnswered'; answered: DotliAuthState }
  | { kind: 'requestFailed'; error: unknown }
  | { kind: 'judged'; outcome: LoginOutcome | null }
  | { kind: 'judgeFailed'; error: unknown }
  | { kind: 'changed' }
  | { kind: 'writeFailed'; error: unknown }
  | { kind: 'roundEnded' };

type CoreLoginEffect =
  | { kind: 'close'; lease: CoreLease; connection: CoreConnection }
  | { kind: 'release'; lease: CoreLease }
  | { kind: 'answer'; login: CoreLogin; outcome: LoginOutcome }
  | { kind: 'reject'; login: CoreLogin; error: unknown }
  | { kind: 'loginRequested' }
  | { kind: 'loginCancelledEarly' }
  | { kind: 'loginCompleted'; outcome: LoginOutcome['kind'] }
  | { kind: 'loginFailed'; error: unknown; tellSession: boolean };

type CoreLoginMachine = MachineTypes<CoreLoginState, CoreLoginEvent, CoreLoginEffect>;

type RequestLoginParams = Pick<CoreLogin, 'reason'> & { lease: CoreLease; connection: CoreConnection };

/** A lease that arrives after its login ended is held by nobody, so it goes at once. */
const releaseStaleLease: HandlerOf<CoreLoginMachine, CoreLoginState['kind'], 'leased'> = (
  _state,
  { lease },
  { emitSideEffect },
) => {
  emitSideEffect({ kind: 'release', lease });
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
  { error },
  { emitState },
) => {
  emitState({ ...state, login: withWriteFailure(state.login, error) });
};

/** The round ended while the login runs on, so the step that follows answers cancelled. */
const recordRoundEnd: HandlerOf<CoreLoginMachine, 'connecting' | 'requesting', 'roundEnded'> = (
  state,
  _event,
  { emitState },
) => {
  emitState({ ...state, login: withRoundEnded(state.login) });
};

/** Returns the topbar's login, logout and cancel on the page core. Never throws. */
export function createCoreAuthCommands({ auth, core, session, isLocalWallet, storedSession }: Params) {
  const machine = createStateMachine<CoreLoginMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        loginAsked(_state, { reason, signal, caller }, transition) {
          const { emitState, emitSideEffect, update } = transition;
          emitSideEffect({ kind: 'loginRequested' });
          function hearChange(): void {
            update({ kind: 'changed' });
          }
          const stops = [
            storedSession.subscribeSessionWriteFailures(error => {
              update({ kind: 'writeFailed', error });
            }),
            storedSession.subscribeStoredSession(hearChange),
            auth.listen(hearChange),
            listen({
              target: signal,
              type: 'abort',
              handler: () => {
                update({ kind: 'roundEnded' });
              },
            }),
          ];
          const login: CoreLogin = {
            id: Symbol('topbar login'),
            reason,
            caller,
            stopWatching() {
              for (const stop of stops) {
                stop();
              }
            },
            writeFailure: null,
            ended: false,
          };
          emitState({ kind: 'acquiring', login });
          update(
            core.acquire().then(
              lease => ({ kind: 'leased', id: login.id, lease }),
              (error: unknown) => ({ kind: 'bootFailed', id: login.id, error }),
            ),
          );
        },
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
      },
      acquiring: {
        leased(state, event, transition) {
          if (event.id !== state.login.id) {
            releaseStaleLease(state, event, transition);
            return;
          }
          transition.emitState({ kind: 'connecting', login: state.login, lease: event.lease });
          transition.update(
            event.lease.connect().then(
              connection => ({ kind: 'connected', connection }),
              (error: unknown) => ({ kind: 'connectFailed', error }),
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
        roundEnded({ login }, _event, transition) {
          transition.emitSideEffect({ kind: 'loginCancelledEarly' });
          answerLogin(login, CANCELLED, transition);
        },
        writeFailed: recordWriteFailure,
      },
      connecting: {
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        connected({ login, lease }, { connection }, transition) {
          if (login.ended) {
            transition.emitSideEffect({ kind: 'close', lease, connection });
            transition.emitSideEffect({ kind: 'loginCancelledEarly' });
            answerLogin(login, CANCELLED, transition);
            return;
          }
          transition.emitState({ kind: 'requesting', login });
          transition.update(
            requestLogin({ reason: login.reason, lease, connection }).then(
              answered => ({ kind: 'requestAnswered', answered }),
              (error: unknown) => ({ kind: 'requestFailed', error }),
            ),
          );
        },
        connectFailed({ login, lease }, { error }, transition) {
          failLogin(login, error, transition);
          transition.emitSideEffect({ kind: 'release', lease });
        },
        roundEnded: recordRoundEnd,
        writeFailed: recordWriteFailure,
      },
      requesting: {
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        requestAnswered({ login }, { answered }, transition) {
          judge(login, answered, transition);
        },
        requestFailed({ login }, { error }, transition) {
          failLogin(login, error, transition);
        },
        roundEnded: recordRoundEnd,
        writeFailed: recordWriteFailure,
      },
      judging: {
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        changed(state, _event, { emitState }) {
          emitState({ ...state, again: true });
        },
        roundEnded(state, _event, { emitState }) {
          emitState({ ...state, login: withRoundEnded(state.login), again: true });
        },
        writeFailed(state, { error }, { emitState }) {
          emitState({ ...state, login: withWriteFailure(state.login, error), again: true });
        },
        judged({ login, answered, again }, { outcome }, transition) {
          if (outcome !== null) {
            transition.emitSideEffect({ kind: 'loginCompleted', outcome: outcome.kind });
            answerLogin(login, outcome, transition);
            return;
          }
          if (again) {
            judge(login, answered, transition);
            return;
          }
          transition.emitState({ kind: 'watching', login, answered });
        },
        judgeFailed({ login }, { error }, transition) {
          rejectLogin(login, error, transition);
        },
      },
      watching: {
        leased: releaseStaleLease,
        bootFailed: reportStaleBootFailure,
        changed({ login, answered }, _event, transition) {
          judge(login, answered, transition);
        },
        roundEnded({ login, answered }, _event, transition) {
          judge(withRoundEnded(login), answered, transition);
        },
        writeFailed({ login, answered }, { error }, transition) {
          judge(withWriteFailure(login, error), answered, transition);
        },
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'close':
          closeStep(() => {
            effect.connection.close();
          }, effect.lease);
          return;
        case 'release':
          effect.lease.release();
          return;
        case 'answer':
          effect.login.stopWatching();
          effect.login.caller.resolve(effect.outcome);
          return;
        case 'reject':
          effect.login.stopWatching();
          effect.login.caller.reject(effect.error);
          return;
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
    const caller = createDeferred<LoginOutcome>();
    machine.update({ kind: 'loginAsked', reason, signal, caller });
    return caller.promise;
  }

  function cancelPairing(): void {
    report.log.event('pairing cancelled');
    core.cancelPairing();
  }

  /**
   * Answers how the sign-in ended once it did: the core reported the account signed in and, for a paired core, the
   * page's copy holds a session. The core may report before its write lands, and the order is its own, so each change
   * of either judges again. A write of the session that failed, or a failed read of it, rejects, and a round that ended
   * answers cancelled.
   */
  function judge(login: CoreLogin, answered: DotliAuthState, transition: Transition<CoreLoginMachine>): void {
    if (login.writeFailure !== null) {
      const error = new Error('The paired session could not be stored', { cause: login.writeFailure.error });
      rejectLogin(login, error, transition);
      return;
    }
    if (login.ended) {
      transition.emitSideEffect({ kind: 'loginCompleted', outcome: 'cancelled' });
      answerLogin(login, CANCELLED, transition);
      return;
    }
    transition.emitState({ kind: 'judging', login, answered, again: false });
    transition.update(
      readSignInOutcome({ state: auth.get(), answered, isLocalWallet, storedSession }).then(
        outcome => ({ kind: 'judged', outcome }),
        (error: unknown) => ({ kind: 'judgeFailed', error }),
      ),
    );
  }

  /**
   * Asks the core to log in over `connection`, and answers the auth state as the core answered, so a state reported
   * since is the core's word on this login. Closes the connection and lets the core go either way. Rejects with what
   * the request or the close threw.
   */
  async function requestLogin({ reason, lease, connection }: RequestLoginParams): Promise<DotliAuthState> {
    const provider = ownCoreConnection(connection);
    try {
      await requestCoreLogin(provider, { reason });
      return auth.get();
    } finally {
      closeStep(() => {
        provider.dispose();
      }, lease);
    }
  }

  return createAuthCommands({ auth, login, cancelPairing });
}

/** Ends the login with `outcome`. */
function answerLogin(
  login: CoreLogin,
  outcome: LoginOutcome,
  { emitState, emitSideEffect }: Transition<CoreLoginMachine>,
): void {
  emitState({ kind: 'idle' });
  emitSideEffect({ kind: 'answer', login, outcome });
}

/** Ends the login with `error`. */
function rejectLogin(
  login: CoreLogin,
  error: unknown,
  { emitState, emitSideEffect }: Transition<CoreLoginMachine>,
): void {
  emitState({ kind: 'idle' });
  emitSideEffect({ kind: 'reject', login, error });
}

/** `login` with its round ended. */
function withRoundEnded(login: CoreLogin): CoreLogin {
  return { ...login, ended: true };
}

/** `login` with `error` as its write failure, unless an earlier one is kept. */
function withWriteFailure(login: CoreLogin, error: unknown): CoreLogin {
  return { ...login, writeFailure: login.writeFailure ?? { error } };
}

/**
 * Ends the login with a failure. The core already rendered a `LoginRequestError`, or stayed silent on purpose, so
 * session state hears only a failure the core never saw. A login whose round the user ended answers cancelled, and
 * session state hears nothing of a failure the user no longer waits on.
 */
function failLogin(login: CoreLogin, error: unknown, transition: Transition<CoreLoginMachine>): void {
  const refused = error instanceof LoginRequestError;
  const cancelled = login.ended || (refused && error.error.tag === 'Cancelled');
  transition.emitSideEffect({ kind: 'loginFailed', error, tellSession: !refused && !login.ended });
  answerLogin(login, cancelled ? CANCELLED : FAILED, transition);
}

/** Closes the login's connection, then lets the core go even when the close throws. Throws what either threw. */
function closeStep(close: () => void, lease: Pick<CoreLease, 'release'>): void {
  try {
    close();
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
