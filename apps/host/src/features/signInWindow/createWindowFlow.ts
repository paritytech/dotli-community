// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in window shows and does once it knows its opener. It decides from the main store, never from the
// opener, offers what is stored or pairs, and delivers what the store holds, at once for a page that resumes a sign-in
// it knows exists. It never answers the opener itself. The request picks only which of these the window starts with.
// Every sign-in it stores or clears, its core's included, goes through the window's one flag keeper, which raises the
// flag first and drops it once the store holds none, so a pairing given up leaves no flag. The window runs no sign-in
// modal: it pairs on its core itself and shows how far the pairing got.

import type { LocalWalletIdentity, LocalWalletReadResult } from '@dotli/protocol';
import { createReporter, defineCount } from '@dotli/metrics';
import { computed, type ReadableAtom } from 'nanostores';
import {
  createDeferred,
  createStateMachine,
  isShallowEqual,
  nest,
  noop,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import { reportLazyMiss } from '../../kit/reportLazyMiss.js';
import type { SignInScreen, WindowIntents } from './sessionWindowState.js';
import type { AuthCommands } from '../account/index.js';
import type { LogoutOutcome, PageSignOut, UntoldLogout } from '../account/index.js';
import { reportLocalWalletFailure, reportWalletFailure } from '../account/index.js';
import type { DotliAuthState } from '../account/index.js';
import type { HostCoreStorage } from '../account/index.js';
import type { SignInFlag } from '../account/index.js';
import type { TruapiSessionUiState } from '../account/index.js';
import type { SignInIntent } from './parseWindowRequest.js';
import type { Responder, ResponderState } from './createResponder.js';
import type { SessionResult } from './parseSessionResult.js';
import { createMainStoreReads } from './createMainStoreReads.js';
import {
  getEndedLoginView,
  getOffered,
  getPairingView,
  getSignInScreen,
  getStopScreen,
  SPINNER,
  type Shown,
} from './windowScreen.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. A step of the sign-in window's own flow that failed, so the window reported it and showed a failure where the
 * view has room. Tagged `outcome` (`error`) and `reason`, the step: `decide`, `continue`, `another`, `phrase`, `back`,
 * `pairing` and `finish`.
 */
const sessionWindowFlowMetric = defineCount<'error'>('session_window.flow');

/** Count. A transition of the sign-in window's flow threw, a bug. Tagged `outcome` (error) and `reason`. */
const sessionWindowFlowTransitionMetric = defineCount<'error'>('session_window.flow_transition');

export type WindowFlow = ReturnType<typeof createWindowFlow>;

/** The recovery phrase check the phrase view loads before it shows. */
export type PhraseCheck = {
  /** The phrase's entropy, or null for anything that is not a recovery phrase. */
  toEntropy: (phrase: string) => Uint8Array | null;
};

export type WindowFlowParams = {
  /** Watched only, so the flow learns where the round stands and never answers the opener itself. */
  responder: Pick<Responder<unknown>, 'state'>;
  /** The page's one flag keeper, so the flow's flag writes and the store writes stay in order. */
  signIns: SignInFlag;
  auth: ReadableAtom<DotliAuthState>;
  /** The window's login on its core. */
  commands: Pick<AuthCommands, 'login'>;
  /** The window's own sign-out, which Use another account runs, and its retry for a phone that missed it. */
  signOut: Pick<PageSignOut, 'signOut' | 'tellAgain'>;
  store: Pick<HostCoreStorage, 'readSession' | 'readUiCache' | 'writeUiCache'>;
  wallet: {
    /** Reads the main store's local wallet. Rejects when it could not be read. */
    read: () => Promise<LocalWalletReadResult>;
    /** Saves a local wallet to the main store. Rejects when it could not be saved. */
    save: (entropy: Uint8Array, identity: LocalWalletIdentity | null) => Promise<void>;
    /** Forgets the main store's local wallet. Rejects when it could not be forgotten. */
    forget: () => Promise<void>;
  };
  /** Loads the phrase check. Rejects when its module could not load. */
  loadPhrase: () => Promise<PhraseCheck>;
  /**
   * What the window's request asks for. A window with a page goes by it as it is. A window with no page only picks its
   * first view from it, so anything but `phrase` signs in, `resume` included, as nobody waits to take what it would
   * send.
   */
  intent: SignInIntent;
  /** The page the window signs in for, as the views name it, or null when no page opened the window. */
  page: string | null;
  /** Takes what the store holds once the flow ended its round for a page. Must not throw. */
  deliver: (result: SessionResult) => void;
  /** Closes the window. */
  close: () => void;
};

/** A closed set, so the metric's `reason` tag stays bounded. */
type StepName = 'decide' | 'continue' | 'another' | 'phrase' | 'back' | 'pairing' | 'finish';

/** Import's promise, which the flow rejects with why the phrase could not be imported. */
type ImportReply = { reject: (error: Error) => void };

/** Every step of the round, with the view it shows. A step that waits on work keeps the view it was asked on. */
type Step = { shown: Shown };

/** A step of Continue's view. */
type Continued = { shown: Extract<Shown, { view: 'continue' }> };

/** A step of the pairing's view. */
type Pairing = { shown: Extract<Shown, { view: 'pairing' }> };

/**
 * The round's flow, from its start to the end of its round. Each step that waits on work is a kind of its own.
 * `loggingIn`, `loginFailing` and `loggingInThenRetry` run the window's login, which waits on the phone and so answers
 * outside `await()`: `loginFailing` shows how the pairing failed while the login still runs, and `loggingInThenRetry`
 * is a Retry pressed then, which decides once the login answered.
 */
type Flow =
  | (Step & { kind: 'starting' })
  | (Step & { kind: 'loadingPhrase' })
  | (Step & { kind: 'readingToOffer' })
  | (Step & { kind: 'readingToSend' })
  | (Step & { kind: 'clearingFlag' })
  | (Step & { kind: 'storingFlag'; stored: SessionResult })
  | (Continued & { kind: 'continue' })
  | (Continued & { kind: 'phoneUntold'; untold: UntoldLogout })
  | (Continued & { kind: 'readingForContinue' })
  | (Continued & { kind: 'loggingOut' })
  | (Continued & { kind: 'checkingSignedOut' })
  | (Continued & { kind: 'forgettingWallet' })
  | (Continued & { kind: 'readingAfterForget' })
  | (Step & { kind: 'phrase'; check: PhraseCheck })
  | (Step & { kind: 'goingBack' })
  | (Step & { kind: 'savingPhrase'; check: PhraseCheck; reply: ImportReply; entropy: Uint8Array })
  | (Step & { kind: 'readingAfterPhrase'; entropy: Uint8Array })
  | (Pairing & { kind: 'loggingIn' })
  | (Pairing & { kind: 'loginFailing' })
  | (Pairing & { kind: 'loggingInThenRetry' })
  | (Pairing & { kind: 'pairingIdle' })
  | (Pairing & { kind: 'finishing'; account: TruapiSessionUiState })
  | (Pairing & { kind: 'cachingAccount'; result: SessionResult })
  | (Step & { kind: 'forgetFailed'; continued: Continued['shown'] })
  | (Step & { kind: 'failed' });

/** The window: its flow while it runs, then the screen it stopped on. */
type State =
  | { kind: 'live'; flow: Flow }
  | { kind: 'refused'; screen: SignInScreen }
  | { kind: 'ended'; screen: SignInScreen }
  | { kind: 'disposed'; screen: SignInScreen };

type Event =
  | { kind: 'responderMoved'; state: ResponderState }
  | { kind: 'started' }
  | { kind: 'authChanged'; auth: DotliAuthState }
  | { kind: 'disposed' }
  | { kind: 'cancelAsked' }
  | { kind: 'continueAsked' }
  | { kind: 'anotherAsked' }
  | { kind: 'goOnAsked' }
  | { kind: 'importAsked'; phrase: string; reply: ImportReply }
  | { kind: 'closePhraseAsked' }
  | { kind: 'retryAsked' }
  | { kind: 'phraseLoaded'; check: PhraseCheck }
  | { kind: 'storedRead'; stored: SessionResult }
  | { kind: 'flagLanded' }
  | { kind: 'loggedOut'; outcome: LogoutOutcome }
  | { kind: 'sessionHeld' }
  | { kind: 'sessionGone' }
  | { kind: 'walletForgotten' }
  | { kind: 'phraseSaved' }
  | { kind: 'sessionRead'; session: SessionResult['session'] }
  | { kind: 'loginPaired'; account: TruapiSessionUiState }
  | { kind: 'loginEnded'; how: 'failed' | 'cancelled' }
  | { kind: 'pairedRead'; blob: string; localWallet: SessionResult['localWallet'] }
  | { kind: 'accountCached' }
  | { kind: 'workFailed'; error: unknown }
  | { kind: 'roundEnded'; result: SessionResult };

type Effect =
  | { kind: 'stepFailed'; name: StepName; error: unknown }
  | { kind: 'walletFailed'; error: Error; action: 'save' | 'forget' }
  | { kind: 'importRejected'; reply: ImportReply; error: Error }
  | { kind: 'phraseMissed'; error: unknown }
  | { kind: 'logged'; line: string }
  | { kind: 'delivered'; result: SessionResult }
  | { kind: 'closed' };

type WindowMachine = MachineTypes<State, Event, Effect>;

type FlowMachine = MachineTypes<Flow, Event, Effect>;

/** The events the flow hears. The window's own handle the round's end and the window's life. */
type FlowEventKind = Exclude<Event['kind'], 'responderMoved' | 'disposed' | 'cancelAsked' | 'roundEnded'>;

/**
 * The steps whose failure leaves the failed view, since their view cannot go on, with the step each reports its failure
 * under.
 */
const FAILED_STEP = {
  readingToOffer: 'decide',
  readingToSend: 'decide',
  goingBack: 'back',
  readingForContinue: 'continue',
  readingAfterPhrase: 'phrase',
  loggingIn: 'pairing',
  loginFailing: 'pairing',
  loggingInThenRetry: 'pairing',
  finishing: 'finish',
  cachingAccount: 'finish',
} satisfies Partial<Record<Flow['kind'], StepName>>;

type FailingKind = keyof typeof FAILED_STEP;

/**
 * The sign-in window's flow for `page`, which decides at once what to show from the main store. An intent pressed
 * while a step runs is ignored and resolves once the flow settled, except Retry over a failed pairing whose login still
 * runs.
 */
export function createWindowFlow({
  responder,
  signIns,
  auth,
  commands,
  signOut,
  store,
  wallet,
  loadPhrase,
  intent: asked,
  page,
  deliver,
  close,
}: WindowFlowParams) {
  const reads = createMainStoreReads({ store, wallet });
  // Nobody waits to take what a window with no page would send, so it signs in unless it was asked for a phrase.
  const intent: SignInIntent = page === null && asked !== 'phrase' ? 'signin' : asked;

  // Every state hears Cancel, so a step under way never holds the window open. A pairing given up stored nothing and so
  // raised no flag.
  const closeWindow: HandlerOf<WindowMachine, 'live' | 'refused' | 'ended', 'cancelAsked'> = (
    _state,
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'closed' });
  };
  const closeOnAnswer: HandlerOf<WindowMachine, 'refused' | 'ended', 'responderMoved'> = (
    _state,
    event,
    { emitSideEffect },
  ) => {
    switch (event.state.kind) {
      case 'answered':
        emitSideEffect({ kind: 'closed' });
        return;
      case 'connecting':
      case 'vetted':
      case 'refused':
      case 'no-opener':
        return;
    }
  };
  const disposeWindow: HandlerOf<WindowMachine, 'live' | 'refused' | 'ended', 'disposed'> = (
    state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'disposed', screen: getScreen(state) });
  };
  const failStep: HandlerOf<FlowMachine, FailingKind, 'workFailed'> = (
    state,
    { error },
    { emitState, emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'stepFailed', name: FAILED_STEP[state.kind], error });
    emitState({ kind: 'failed', shown: { view: 'failed' } });
  };
  /** Use another account failed, so Continue offers what it offered with the failure on show. */
  const failAnother: HandlerOf<FlowMachine, 'loggingOut' | 'checkingSignedOut' | 'readingAfterForget', 'workFailed'> = (
    { shown },
    { error },
    { emitState, emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'stepFailed', name: 'another', error });
    emitState({ kind: 'continue', shown: { ...shown, failure: 'step' } });
  };
  // Only a running login is followed, so a failure a login left stays on show whatever the auth state does. The login's
  // answer, not the auth state, decides how a pairing ends.
  const followLogin: HandlerOf<FlowMachine, 'loggingIn' | 'loginFailing', 'authChanged'> = (
    { shown },
    { auth: changed },
    { emitState },
  ) => {
    const pairing = getPairingView(shown.pairing, changed);
    emitState({ kind: pairing.kind === 'error' ? 'loginFailing' : 'loggingIn', shown: { ...shown, pairing } });
  };
  /** A login whose retry is asked, or that already paired, only shows how far the core got. */
  const followAuth: HandlerOf<FlowMachine, 'loggingInThenRetry' | 'finishing' | 'cachingAccount', 'authChanged'> = (
    state,
    { auth: changed },
    { emitState },
  ) => {
    emitState({ ...state, shown: { ...state.shown, pairing: getPairingView(state.shown.pairing, changed) } });
  };
  /** Sends what the login paired, which the command answered only once the main store held it. */
  const finishPairing: HandlerOf<FlowMachine, 'loggingIn' | 'loginFailing' | 'loggingInThenRetry', 'loginPaired'> = (
    { shown },
    { account },
    { emitState, update },
  ) => {
    emitState({ kind: 'finishing', shown, account });
    update(reads.readPaired().then(paired => ({ kind: 'pairedRead', ...paired }), mapWorkFailure));
  };
  /**
   * Offers what the store holds, else pairs. With nothing stored, a flag left set claims a sign-in that is gone, and
   * the keeper drops it only while the store is still empty, so a pairing under way that stores meanwhile keeps it.
   */
  const offerOrPair: HandlerOf<
    FlowMachine,
    'readingToOffer' | 'goingBack' | 'readingToSend' | 'readingForContinue',
    'storedRead'
  > = ({ shown }, { stored }, { emitState, update }) => {
    const offered = getOffered(stored);
    if (offered !== null) {
      emitState({ kind: 'continue', shown: { view: 'continue', offered, failure: null } });
      return;
    }
    emitState({ kind: 'clearingFlag', shown });
    // Never rejects, since no drop runs.
    update(signIns.clear().then(() => ({ kind: 'flagLanded' })));
  };
  /**
   * Sends what the store holds, with the flag landed first, since the page reads it as it takes the result. A store
   * with nothing to send, such as a flag left set over an empty store, drops the flag and pairs.
   */
  const send: HandlerOf<FlowMachine, 'readingToSend' | 'readingForContinue', 'storedRead'> = (
    state,
    event,
    transition,
  ) => {
    if (getOffered(event.stored) === null) {
      offerOrPair(state, event, transition);
      return;
    }
    transition.emitState({ kind: 'storingFlag', shown: state.shown, stored: event.stored });
    // Never rejects, since the write does nothing.
    transition.update(signIns.store(noop).then(() => ({ kind: 'flagLanded' })));
  };

  const followFlow = nest<WindowMachine, 'live', FlowMachine, FlowEventKind>({
    find: ({ flow }) => flow,
    store: (state, _event, flow) => ({ ...state, flow }),
    handlers: {
      starting: {
        started(state, _event, transition) {
          decide(state, transition);
        },
      },
      loadingPhrase: {
        phraseLoaded(_state, { check }, { emitState }) {
          emitState({ kind: 'phrase', shown: { view: 'phrase' }, check });
        },
        // A module that could not load is a missed chunk, so the step itself ends without failing.
        workFailed(_state, { error }, { emitState, emitSideEffect }) {
          emitSideEffect({ kind: 'phraseMissed', error });
          emitState({ kind: 'failed', shown: { view: 'failed' } });
        },
      },
      readingToOffer: {
        storedRead: offerOrPair,
        workFailed: failStep,
      },
      readingToSend: {
        storedRead: send,
        workFailed: failStep,
      },
      clearingFlag: {
        flagLanded(_state, _event, transition) {
          pair(transition);
        },
      },
      storingFlag: {
        flagLanded({ stored }, _event, { update }) {
          update({ kind: 'roundEnded', result: stored });
        },
      },
      continue: {
        continueAsked({ shown }, _event, { emitState, update }) {
          emitState({ kind: 'readingForContinue', shown });
          update(toStoredRead(reads.readStoredForContinue(shown.offered.stored)));
        },
        anotherAsked(state, _event, transition) {
          logOut(state, () => signOut.signOut(), transition);
        },
      },
      phoneUntold: {
        // Try again on that failure tells the phone once more from what the sign-out left.
        anotherAsked(state, _event, transition) {
          logOut(state, () => signOut.tellAgain(state.untold), transition);
        },
        goOnAsked(state, _event, transition) {
          transition.emitSideEffect({ kind: 'logged', line: 'sign-in window goes on with the phone not told' });
          leaveForAnother(state, transition);
        },
      },
      readingForContinue: {
        storedRead: send,
        workFailed: failStep,
      },
      loggingOut: {
        loggedOut({ shown }, { outcome }, transition) {
          switch (outcome.phone) {
            case 'untold':
              transition.emitState({
                kind: 'phoneUntold',
                shown: { ...shown, failure: 'phone' },
                untold: outcome,
              });
              return;
            case 'told':
              leaveForAnother({ shown }, transition);
              return;
          }
        },
        workFailed: failAnother,
      },
      checkingSignedOut: {
        sessionHeld({ shown }, _event, { emitState }) {
          emitState({ kind: 'continue', shown: { ...shown, failure: 'sign-out' } });
        },
        sessionGone(state, _event, transition) {
          forgetWallet(state, transition);
        },
        workFailed: failAnother,
      },
      forgettingWallet: {
        walletForgotten(_state, _event, transition) {
          pair(transition);
        },
        // The wallet is still stored, so the flag stays up for it.
        workFailed({ shown }, { error }, { emitState, emitSideEffect, update }) {
          const failure = new Error('Local wallet could not be forgotten', { cause: error });
          emitSideEffect({ kind: 'walletFailed', error: failure, action: 'forget' });
          emitState({ kind: 'readingAfterForget', shown });
          update(toStoredRead(reads.readStored()));
        },
      },
      readingAfterForget: {
        storedRead({ shown }, { stored }, { emitState }) {
          const offered = getOffered(stored);
          // A wallet that cannot be read may still be stored, so the window starts no pairing over it, and Retry
          // forgets it again first.
          if (offered === null) {
            emitState({ kind: 'forgetFailed', shown: { view: 'failed' }, continued: shown });
            return;
          }
          emitState({ kind: 'continue', shown: { view: 'continue', offered, failure: 'sign-out' } });
        },
        workFailed: failAnother,
      },
      phrase: {
        importAsked({ shown, check }, { phrase, reply }, { emitState, emitSideEffect, update }) {
          const entropy = check.toEntropy(phrase);
          if (entropy === null) {
            const error = new Error('Not a valid recovery phrase');
            emitSideEffect({ kind: 'stepFailed', name: 'phrase', error });
            emitSideEffect({ kind: 'importRejected', reply, error });
            return;
          }
          emitState({ kind: 'savingPhrase', shown, check, reply, entropy });
          // Only a local wallet core reads the identity, and a window that takes a phrase pairs, so it saves none.
          update(signIns.store(() => wallet.save(entropy, null)).then(() => ({ kind: 'phraseSaved' }), mapWorkFailure));
        },
        closePhraseAsked({ shown }, _event, { emitState, update }) {
          emitState({ kind: 'goingBack', shown });
          update(toStoredRead(reads.readStored()));
        },
      },
      goingBack: {
        storedRead: offerOrPair,
        workFailed: failStep,
      },
      savingPhrase: {
        phraseSaved({ shown, entropy }, _event, { emitState, emitSideEffect, update }) {
          emitSideEffect({ kind: 'logged', line: 'sign-in window saved a recovery phrase wallet' });
          emitState({ kind: 'readingAfterPhrase', shown, entropy });
          // A paired session stays, so the user can switch back to it. A session that cannot be read now fails the
          // step on the failed view, since the form saying the save failed would be wrong.
          update(readSessionAfterSave(reads.readSession()));
        },
        // The form shows the failure from the import's rejection, which is reported before it rejects.
        workFailed({ shown, check, reply }, { error: cause }, { emitState, emitSideEffect }) {
          const error = new Error('The recovery phrase wallet could not be saved', { cause });
          emitSideEffect({ kind: 'walletFailed', error, action: 'save' });
          emitSideEffect({ kind: 'importRejected', reply, error });
          emitState({ kind: 'phrase', shown, check });
        },
      },
      readingAfterPhrase: {
        sessionRead({ entropy }, { session }, { update }) {
          update({ kind: 'roundEnded', result: { session, localWallet: { entropy, identity: null } } });
        },
        workFailed: failStep,
      },
      loggingIn: {
        // A login that ends without a sign-in leaves a failure on show for Retry, one that says how it ended, so no
        // dead code stays up.
        loginEnded({ shown }, { how }, { emitState }) {
          emitState({ kind: 'pairingIdle', shown: { ...shown, pairing: getEndedLoginView(how) } });
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followLogin,
      },
      loginFailing: {
        // The core's own failure stays on show for Retry.
        loginEnded({ shown }, _event, { emitState }) {
          emitState({ kind: 'pairingIdle', shown });
        },
        // Retry decides only once the login under way answered, so it never lands in the round of the failed one.
        retryAsked({ shown }, _event, { emitState }) {
          emitState({ kind: 'loggingInThenRetry', shown });
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followLogin,
      },
      loggingInThenRetry: {
        loginEnded(_state, _event, transition) {
          retryPairing(transition);
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followAuth,
      },
      pairingIdle: {
        retryAsked(_state, _event, transition) {
          retryPairing(transition);
        },
      },
      finishing: {
        pairedRead({ shown, account }, { blob, localWallet }, { emitState, update }) {
          // From the account the login answered with. The window runs no session state to cache it, so it caches it
          // here, for a page that shows the main store without a core of its own and for a later Continue.
          const uiState = JSON.stringify(account);
          emitState({ kind: 'cachingAccount', shown, result: { session: { blob, uiState }, localWallet } });
          update(store.writeUiCache(uiState).then(() => ({ kind: 'accountCached' }), mapWorkFailure));
        },
        workFailed: failStep,
        authChanged: followAuth,
      },
      cachingAccount: {
        accountCached({ result }, _event, { update }) {
          update({ kind: 'roundEnded', result });
        },
        workFailed: failStep,
        authChanged: followAuth,
      },
      forgetFailed: {
        retryAsked({ continued }, _event, transition) {
          forgetWallet({ shown: continued }, transition);
        },
      },
      failed: {
        retryAsked(state, _event, transition) {
          decide(state, transition);
        },
      },
    },
  });

  const machine = createStateMachine<WindowMachine>({
    initial: {
      kind: 'live',
      flow: {
        kind: 'starting',
        shown: { view: 'connecting' },
      },
    },
    handlers: {
      live: {
        responderMoved(_state, event, transition) {
          switch (event.state.kind) {
            case 'refused':
              transition.emitState({ kind: 'refused', screen: getStopScreen('refused', page) });
              return;
            case 'answered':
              transition.emitSideEffect({ kind: 'closed' });
              return;
            case 'connecting':
            case 'vetted':
            case 'no-opener':
              return;
          }
        },
        // The round's result goes to the page that opened the window, or is said as done when no page did.
        roundEnded({ flow }, { result }, { emitState, emitSideEffect }) {
          if (page === null) {
            emitState({ kind: 'ended', screen: getStopScreen('done-no-opener', null) });
            emitSideEffect({ kind: 'logged', line: 'sign-in window signed in with no opener' });
            return;
          }
          emitState({ kind: 'ended', screen: getSignInScreen(flow.shown, page) });
          emitSideEffect({ kind: 'logged', line: 'sign-in window sends its result' });
          emitSideEffect({ kind: 'delivered', result });
        },
        cancelAsked: closeWindow,
        disposed: disposeWindow,
        started: followFlow,
        authChanged: followFlow,
        continueAsked: followFlow,
        anotherAsked: followFlow,
        goOnAsked: followFlow,
        importAsked: followFlow,
        closePhraseAsked: followFlow,
        retryAsked: followFlow,
        phraseLoaded: followFlow,
        storedRead: followFlow,
        flagLanded: followFlow,
        loggedOut: followFlow,
        sessionHeld: followFlow,
        sessionGone: followFlow,
        walletForgotten: followFlow,
        phraseSaved: followFlow,
        sessionRead: followFlow,
        loginPaired: followFlow,
        loginEnded: followFlow,
        pairedRead: followFlow,
        accountCached: followFlow,
        workFailed: followFlow,
      },
      refused: {
        responderMoved: closeOnAnswer,
        cancelAsked: closeWindow,
        disposed: disposeWindow,
      },
      ended: {
        responderMoved: closeOnAnswer,
        cancelAsked: closeWindow,
        disposed: disposeWindow,
      },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'stepFailed':
          reportWalletFailure(effect.error, {
            what: `session window ${effect.name}`,
            step: 'session_window',
            reason: effect.name,
            metric: sessionWindowFlowMetric,
          });
          return;
        case 'walletFailed':
          reportLocalWalletFailure(effect.error, effect.action);
          return;
        case 'importRejected':
          effect.reply.reject(effect.error);
          return;
        case 'phraseMissed':
          reportLazyMiss({ report, step: 'phrase_import', error: effect.error });
          return;
        case 'logged':
          report.log.event(effect.line);
          return;
        case 'delivered':
          deliver(effect.result);
          return;
        case 'closed':
          close();
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'flow_transition',
        metric: sessionWindowFlowTransitionMetric,
        message: '[dot.li] A sign-in window flow transition threw',
      });
    },
  });
  const screen: ReadableAtom<SignInScreen> = computed(machine.state, getScreen);
  // A screen derived again with the same fields keeps the one on show, so the window renders only what changed.
  screen.eq = isShallowEqual;

  const stopFollowingResponder = responder.state.subscribe(state => {
    machine.update({ kind: 'responderMoved', state });
  });
  // Read at delivery, so a listener heard before this one that moved the auth state on shows its step, not the one
  // it moved past.
  const stopFollowingAuth = auth.listen(() => {
    machine.update({ kind: 'authChanged', auth: auth.get() });
  });
  // After the responder was heard, so a window that already refused its opener starts nothing.
  machine.update({ kind: 'started' });

  /** Sends `event`, and resolves once the flow's work it started settled. */
  function ask(event: Event): Promise<void> {
    machine.update(event);
    return machine.await();
  }

  const intents: WindowIntents = {
    continueWithStored: () => ask({ kind: 'continueAsked' }),
    useAnotherAccount: () => ask({ kind: 'anotherAsked' }),
    goOnWithoutPhone: () => ask({ kind: 'goOnAsked' }),
    isValidPhrase(phrase) {
      // Only the phrase view's steps hold the check, so any other state has left that view or not shown it yet.
      const state = machine.state.get();
      return state.kind === 'live' && 'check' in state.flow && state.flow.check.toEntropy(phrase) !== null;
    },
    importPhrase(phrase) {
      const reply = createDeferred<undefined>();
      // Heard before the import is asked, since a phrase that is no recovery phrase rejects the reply at once.
      const answered = reply.promise.then(noop);
      // An import the flow ignores gets no reply, so it resolves once the flow settled, as every ignored intent does.
      void ask({ kind: 'importAsked', phrase, reply }).then(() => {
        reply.resolve(undefined);
      });
      return answered;
    },
    closePhrase: () => ask({ kind: 'closePhraseAsked' }),
    retry: () => ask({ kind: 'retryAsked' }),
    cancel() {
      machine.update({ kind: 'cancelAsked' });
    },
  };

  return {
    /** What the window shows, which is always a view of a sign-in. */
    screen,
    /**
     * Resolves once the flow's own work settled, every step it started included. Never waits on the user or the phone,
     * so a login under way does not hold it.
     */
    await: () => machine.await(),
    ...intents,
    /**
     * Stops watching the responder and the auth state, and never disposes the responder, which is its caller's. After
     * it, a step that lands changes nothing, every intent does nothing, and `cancel()` no longer closes the window. Safe
     * to call twice.
     */
    dispose(): void {
      stopFollowingResponder();
      stopFollowingAuth();
      machine.update({ kind: 'disposed' });
    },
  };

  /**
   * The first view, and Retry's after a step that failed. A page that knows a sign-in exists elsewhere asked to take it,
   * so the window sends it without offering Continue first.
   */
  function decide(step: Step, transition: Transition<FlowMachine>): void {
    const { shown } = step;
    switch (intent) {
      case 'phrase':
        transition.emitState({ kind: 'loadingPhrase', shown });
        transition.update(loadPhrase().then(check => ({ kind: 'phraseLoaded', check }), mapWorkFailure));
        return;
      case 'resume':
        transition.emitSideEffect({ kind: 'logged', line: 'sign-in window resumes the stored sign-in' });
        transition.emitState({ kind: 'readingToSend', shown });
        transition.update(toStoredRead(reads.readStored()));
        return;
      case 'signin':
        readToOffer(step, transition);
        return;
    }
  }

  function readToOffer({ shown }: Step, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'readingToOffer', shown });
    update(toStoredRead(reads.readStored()));
  }

  /** Retry over a failed pairing shows the spinner while the store decides again what to offer. */
  function retryPairing(transition: Transition<FlowMachine>): void {
    readToOffer({ shown: { view: 'pairing', pairing: SPINNER } }, transition);
  }

  /** Shows the pairing and logs in. The login waits on the phone, so it answers outside `await()`. */
  function pair({ emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'loggingIn', shown: { view: 'pairing', pairing: SPINNER } });
    void commands
      .login()
      .then(
        (outcome): Event =>
          outcome.kind === 'paired'
            ? { kind: 'loginPaired', account: outcome.account }
            : { kind: 'loginEnded', how: outcome.kind },
        mapWorkFailure,
      )
      .then(update);
  }

  /**
   * Starts a sign-out that tells the phone, or tells it again, once the step shows it, and waits on it. A failure is
   * reported by the sign-out itself. The phone keeps this browser listed until it is told, so the window goes on only
   * once it was, or the user chooses to.
   */
  function logOut(
    { shown }: Continued,
    startSignOut: () => Promise<LogoutOutcome>,
    { emitState, emitSideEffect, update }: Transition<FlowMachine>,
  ): void {
    emitSideEffect({ kind: 'logged', line: 'sign-in window uses another account' });
    emitState({ kind: 'loggingOut', shown });
    update(startSignOut().then(told => ({ kind: 'loggedOut', outcome: told }), mapWorkFailure));
  }

  /** Forgets the wallet through the flag keeper, which drops the flag once the store holds no sign-in. */
  function forgetWallet({ shown }: Continued, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'forgettingWallet', shown });
    update(
      signIns
        .clear({ drop: () => wallet.forget().then(() => true) })
        .then(() => ({ kind: 'walletForgotten' }), mapWorkFailure),
    );
  }

  /** The rest of Use another account once the paired session ended: forget the wallet and pair. */
  function leaveForAnother({ shown }: Continued, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'checkingSignedOut', shown });
    // A store that cannot be read may still hold the session, so the window does not go on over it.
    update(reads.isSessionGone().then(gone => ({ kind: gone ? 'sessionGone' : 'sessionHeld' }), mapWorkFailure));
  }

  function getScreen(state: State): SignInScreen {
    switch (state.kind) {
      case 'live':
        return getSignInScreen(state.flow.shown, page);
      case 'refused':
      case 'ended':
      case 'disposed':
        return state.screen;
    }
  }
}

function toStoredRead(read: Promise<SessionResult>): Promise<Event> {
  return read.then(stored => ({ kind: 'storedRead', stored }), mapWorkFailure);
}

function readSessionAfterSave(read: Promise<SessionResult['session']>): Promise<Event> {
  return read.then(
    session => ({ kind: 'sessionRead', session }),
    (error: unknown) =>
      mapWorkFailure(new Error('The paired session could not be read after the wallet saved', { cause: error })),
  );
}

function mapWorkFailure(error: unknown): Extract<Event, { kind: 'workFailed' }> {
  return { kind: 'workFailed', error };
}
