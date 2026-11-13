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
  createStateMachine,
  isShallowEqual,
  nest,
  noop,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import { reportLazyMiss } from '../../reportLazyMiss.js';
import type { PairingView } from '../../state/authModalState.js';
import type { SignInScreen, WindowIntents } from '../../state/sessionWindowState.js';
import type { AuthCommands } from '../runAuthCommand.js';
import type { LogoutOutcome, PageSignOut, UntoldLogout } from '../createPageSignOut.js';
import { reportLocalWalletFailure, reportWalletFailure } from '../walletFailure.js';
import type { DotliAuthState } from '../session/types.js';
import type { HostCoreStorage } from '../session/createCoreStorage.js';
import type { SignInFlag } from '../session/signInFlag.js';
import type { TruapiSessionUiState } from '../session/parseUiStateCache.js';
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
   * What the window's request asks for. A vetted round goes by it as it is. A window with no opener only picks its
   * first view from it, so anything but `phrase` signs in, `resume` included, as nobody waits to take what it would
   * send.
   */
  intent: SignInIntent;
  /** How the views name the page the window signs in for, from its vetted origin. */
  pageLabel: (origin: string) => string;
  /** Takes what the store holds once the flow ended its round with a vetted opener. Must not throw. */
  deliver: (result: SessionResult) => void;
  /** Closes the window. */
  close: () => void;
};

/** A closed set, so the metric's `reason` tag stays bounded. */
type StepName = 'decide' | 'continue' | 'another' | 'phrase' | 'back' | 'pairing' | 'finish';

/** What a round keeps from its opening, with how far its pairing got, which every view carries. */
type Round = {
  intent: SignInIntent;
  /** The page the window signs in for, null until the opener is known and when no page opened the window. */
  page: string | null;
  pairing: PairingView;
};

/** Every step of the round, with the view it shows. A step that waits on work keeps the view it was asked on. */
type Step = { round: Round; shown: Shown };

/** A step of Continue's view. */
type Continued = { round: Round; shown: Extract<Shown, { view: 'continue' }> };

/**
 * The round's flow, from the hello it waits for to the end of its round. Each step that waits on work is a kind of its
 * own. `loggingIn`, `loginFailing` and `loggingInThenRetry` run the window's login, which waits on the phone and so
 * answers through its callback: `loginFailing` shows how the pairing failed while the login still runs, and
 * `loggingInThenRetry` is a Retry pressed then, which decides once the login answered.
 */
type Flow =
  | (Step & { kind: 'waiting' })
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
  | (Step & { kind: 'phraseRejected'; check: PhraseCheck; asker: symbol; error: Error })
  | (Step & { kind: 'goingBack' })
  | (Step & { kind: 'savingPhrase'; check: PhraseCheck; asker: symbol; entropy: Uint8Array })
  | (Step & { kind: 'readingAfterPhrase'; entropy: Uint8Array })
  | (Step & { kind: 'loggingIn' })
  | (Step & { kind: 'loginFailing' })
  | (Step & { kind: 'loggingInThenRetry' })
  | (Step & { kind: 'pairingIdle' })
  | (Step & { kind: 'finishing'; account: TruapiSessionUiState })
  | (Step & { kind: 'cachingAccount'; result: SessionResult })
  | (Step & { kind: 'failed' });

/** The window: its flow while it runs, then the screen it stopped on. */
type State =
  | { kind: 'live'; flow: Flow }
  | { kind: 'refused'; screen: SignInScreen }
  | { kind: 'ended'; screen: SignInScreen }
  | { kind: 'disposed'; screen: SignInScreen };

type Event =
  | { kind: 'responderMoved'; state: ResponderState }
  // `origin` is the vetted opener's, and null for a window with no opener.
  | { kind: 'openerKnown'; origin: string | null }
  | { kind: 'authChanged'; auth: DotliAuthState }
  | { kind: 'disposed' }
  | { kind: 'cancelAsked' }
  | { kind: 'continueAsked' }
  | { kind: 'anotherAsked' }
  | { kind: 'goOnAsked' }
  | { kind: 'importAsked'; phrase: string; asker: symbol }
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
 * The sign-in window's flow over `responder`, which starts deciding once the responder knows its opener. An intent
 * pressed while a step runs is ignored and resolves once the flow settled, except Retry over a failed pairing whose
 * login still runs.
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
  intent,
  pageLabel,
  deliver,
  close,
}: WindowFlowParams) {
  const reads = createMainStoreReads({ store, wallet });

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
    if (event.state.kind === 'answered') {
      emitSideEffect({ kind: 'closed' });
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
    emitState({ kind: 'failed', round: state.round, shown: { view: 'failed' } });
  };
  /** Use another account failed, so Continue offers what it offered with the failure on show. */
  const failAnother: HandlerOf<FlowMachine, 'loggingOut' | 'checkingSignedOut' | 'readingAfterForget', 'workFailed'> = (
    { round, shown },
    { error },
    { emitState, emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'stepFailed', name: 'another', error });
    emitState({ kind: 'continue', round, shown: { ...shown, failure: 'step' } });
  };
  // Only a running login is followed, so a failure a login left stays on show whatever the auth state does. The login's
  // answer, not the auth state, decides how a pairing ends.
  const followLogin: HandlerOf<FlowMachine, 'loggingIn' | 'loginFailing', 'authChanged'> = (
    { round, shown },
    { auth: changed },
    { emitState },
  ) => {
    const next = { ...round, pairing: getPairingView(round.pairing, changed) };
    emitState({ kind: next.pairing.kind === 'error' ? 'loginFailing' : 'loggingIn', round: next, shown });
  };
  /** A login whose retry is asked, or that already paired, only shows how far the core got. */
  const followAuth: HandlerOf<FlowMachine, 'loggingInThenRetry' | 'finishing' | 'cachingAccount', 'authChanged'> = (
    state,
    { auth: changed },
    { emitState },
  ) => {
    emitState({ ...state, round: { ...state.round, pairing: getPairingView(state.round.pairing, changed) } });
  };
  /** Sends what the login paired, which the command answered only once the main store held it. */
  const finishPairing: HandlerOf<FlowMachine, 'loggingIn' | 'loginFailing' | 'loggingInThenRetry', 'loginPaired'> = (
    { round, shown },
    { account },
    { emitState, update },
  ) => {
    emitState({ kind: 'finishing', round, shown, account });
    update(reads.readPaired().then(paired => ({ kind: 'pairedRead', ...paired }), mapWorkFailure));
  };
  const importPhrase: HandlerOf<FlowMachine, 'phrase' | 'phraseRejected', 'importAsked'> = (
    { round, shown, check },
    { phrase, asker },
    { emitState, emitSideEffect, update },
  ) => {
    const entropy = check.toEntropy(phrase);
    if (entropy === null) {
      const error = new Error('Not a valid recovery phrase');
      emitSideEffect({ kind: 'stepFailed', name: 'phrase', error });
      emitState({ kind: 'phraseRejected', round, shown, check, asker, error });
      return;
    }
    emitState({ kind: 'savingPhrase', round, shown, check, asker, entropy });
    // Only a local wallet core reads the identity, and a window that takes a phrase pairs, so it saves none.
    update(signIns.store(() => wallet.save(entropy, null)).then(() => ({ kind: 'phraseSaved' }), mapWorkFailure));
  };
  const goBack: HandlerOf<FlowMachine, 'phrase' | 'phraseRejected', 'closePhraseAsked'> = (
    { round, shown },
    _event,
    { emitState, update },
  ) => {
    emitState({ kind: 'goingBack', round, shown });
    update(toStoredRead(reads.readStored()));
  };
  /**
   * Offers what the store holds, else pairs. With nothing stored, a flag left set claims a sign-in that is gone, and
   * the keeper drops it only while the store is still empty, so a pairing under way that stores meanwhile keeps it.
   */
  const offerOrPair: HandlerOf<
    FlowMachine,
    'readingToOffer' | 'goingBack' | 'readingToSend' | 'readingForContinue',
    'storedRead'
  > = ({ round, shown }, { stored }, { emitState, update }) => {
    const offered = getOffered(stored);
    if (offered !== null) {
      emitState({ kind: 'continue', round, shown: { view: 'continue', offered, failure: null } });
      return;
    }
    emitState({ kind: 'clearingFlag', round, shown });
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
    transition.emitState({ kind: 'storingFlag', round: state.round, shown: state.shown, stored: event.stored });
    // Never rejects, since the write does nothing.
    transition.update(signIns.store(noop).then(() => ({ kind: 'flagLanded' })));
  };

  const followFlow = nest<WindowMachine, 'live', FlowMachine, FlowEventKind>({
    find: ({ flow }) => flow,
    store: (state, _event, flow) => ({ ...state, flow }),
    handlers: {
      waiting: {
        openerKnown({ round, shown }, { origin }, transition) {
          const known: Round =
            origin === null
              ? { ...round, intent: round.intent === 'phrase' ? 'phrase' : 'signin' }
              : { ...round, page: pageLabel(origin) };
          decide({ round: known, shown }, transition);
        },
      },
      loadingPhrase: {
        phraseLoaded({ round }, { check }, { emitState }) {
          emitState({ kind: 'phrase', round, shown: { view: 'phrase' }, check });
        },
        // A module that could not load is a missed chunk, so the step itself ends without failing.
        workFailed({ round }, { error }, { emitState, emitSideEffect }) {
          emitSideEffect({ kind: 'phraseMissed', error });
          emitState({ kind: 'failed', round, shown: { view: 'failed' } });
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
        flagLanded({ round }, _event, transition) {
          pair(round, transition);
        },
      },
      storingFlag: {
        flagLanded({ stored }, _event, { update }) {
          update({ kind: 'roundEnded', result: stored });
        },
      },
      continue: {
        continueAsked({ round, shown }, _event, { emitState, update }) {
          emitState({ kind: 'readingForContinue', round, shown });
          update(toStoredRead(reads.readStoredForContinue(shown.offered.stored)));
        },
        anotherAsked(state, _event, transition) {
          logOut(state, null, transition);
        },
      },
      phoneUntold: {
        // Try again on that failure tells the phone once more from what the sign-out left.
        anotherAsked({ round, shown, untold }, _event, transition) {
          logOut({ round, shown }, untold, transition);
        },
        goOnAsked({ round, shown }, _event, transition) {
          transition.emitSideEffect({ kind: 'logged', line: 'sign-in window goes on with the phone not told' });
          leaveForAnother({ round, shown }, transition);
        },
      },
      readingForContinue: {
        storedRead: send,
        workFailed: failStep,
      },
      loggingOut: {
        loggedOut({ round, shown }, { outcome }, transition) {
          switch (outcome.phone) {
            case 'untold':
              transition.emitState({
                kind: 'phoneUntold',
                round,
                shown: { ...shown, failure: 'phone' },
                untold: outcome,
              });
              return;
            case 'told':
              leaveForAnother({ round, shown }, transition);
              return;
          }
        },
        workFailed: failAnother,
      },
      checkingSignedOut: {
        sessionHeld({ round, shown }, _event, { emitState }) {
          emitState({ kind: 'continue', round, shown: { ...shown, failure: 'sign-out' } });
        },
        sessionGone({ round, shown }, _event, { emitState, update }) {
          emitState({ kind: 'forgettingWallet', round, shown });
          update(
            signIns
              .clear({
                drop: async () => {
                  await wallet.forget();
                  return true;
                },
              })
              .then(() => ({ kind: 'walletForgotten' }), mapWorkFailure),
          );
        },
        workFailed: failAnother,
      },
      forgettingWallet: {
        walletForgotten({ round }, _event, transition) {
          pair(round, transition);
        },
        // The wallet is still stored, so the flag stays up for it.
        workFailed({ round, shown }, { error }, { emitState, emitSideEffect, update }) {
          const failure = new Error('Local wallet could not be forgotten', { cause: error });
          emitSideEffect({ kind: 'walletFailed', error: failure, action: 'forget' });
          emitState({ kind: 'readingAfterForget', round, shown });
          update(toStoredRead(reads.readStored()));
        },
      },
      readingAfterForget: {
        storedRead({ round }, { stored }, { emitState }) {
          const offered = getOffered(stored);
          // A wallet that cannot be read may still be stored, so the window starts no pairing over it.
          if (offered === null) {
            emitState({ kind: 'failed', round, shown: { view: 'failed' } });
            return;
          }
          emitState({ kind: 'continue', round, shown: { view: 'continue', offered, failure: 'sign-out' } });
        },
        workFailed: failAnother,
      },
      phrase: {
        importAsked: importPhrase,
        closePhraseAsked: goBack,
      },
      phraseRejected: {
        importAsked: importPhrase,
        closePhraseAsked: goBack,
      },
      goingBack: {
        storedRead: offerOrPair,
        workFailed: failStep,
      },
      savingPhrase: {
        phraseSaved({ round, shown, entropy }, _event, { emitState, emitSideEffect, update }) {
          emitSideEffect({ kind: 'logged', line: 'sign-in window saved a recovery phrase wallet' });
          emitState({ kind: 'readingAfterPhrase', round, shown, entropy });
          // A paired session stays, so the user can switch back to it. A session that cannot be read now fails the
          // step on the failed view, since the form saying the save failed would be wrong.
          update(
            reads.readSession().then(
              session => ({ kind: 'sessionRead', session }),
              (error: unknown) =>
                mapWorkFailure(
                  new Error('The paired session could not be read after the wallet saved', { cause: error }),
                ),
            ),
          );
        },
        // The form shows the failure from the import's rejection, which is reported before it rejects.
        workFailed({ round, shown, check, asker }, { error: cause }, { emitState, emitSideEffect }) {
          const error = new Error('The recovery phrase wallet could not be saved', { cause });
          emitSideEffect({ kind: 'walletFailed', error, action: 'save' });
          emitState({ kind: 'phraseRejected', round, shown, check, asker, error });
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
        loginEnded({ round, shown }, { how }, { emitState }) {
          emitState({ kind: 'pairingIdle', round: { ...round, pairing: getEndedLoginView(how) }, shown });
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followLogin,
      },
      loginFailing: {
        // The core's own failure stays on show for Retry.
        loginEnded({ round, shown }, _event, { emitState }) {
          emitState({ kind: 'pairingIdle', round, shown });
        },
        // Retry decides only once the login under way answered, so it never lands in the round of the failed one.
        retryAsked({ round, shown }, _event, { emitState }) {
          emitState({ kind: 'loggingInThenRetry', round, shown });
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followLogin,
      },
      loggingInThenRetry: {
        loginEnded({ round }, _event, transition) {
          retryPairing(round, transition);
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followAuth,
      },
      pairingIdle: {
        retryAsked({ round }, _event, transition) {
          retryPairing(round, transition);
        },
      },
      finishing: {
        pairedRead({ round, shown, account }, { blob, localWallet }, { emitState, update }) {
          // From the account the login answered with. The window runs no session state to cache it, so it caches it
          // here, for a page that shows the main store without a core of its own and for a later Continue.
          const uiState = JSON.stringify(account);
          emitState({ kind: 'cachingAccount', round, shown, result: { session: { blob, uiState }, localWallet } });
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
      failed: {
        // No login runs here, so whatever pairing is on show was left by one that ended, and gives way to the spinner.
        retryAsked({ round, shown }, _event, transition) {
          decide({ round: { ...round, pairing: SPINNER }, shown }, transition);
        },
      },
    },
  });

  const machine = createStateMachine<WindowMachine>({
    initial: {
      kind: 'live',
      flow: {
        kind: 'waiting',
        round: { intent, page: null, pairing: getPairingView(SPINNER, auth.get()) },
        shown: { view: 'connecting' },
      },
    },
    handlers: {
      live: {
        responderMoved(state, event, transition) {
          switch (event.state.kind) {
            case 'refused':
              transition.emitState({ kind: 'refused', screen: getStopScreen(state.flow, 'refused') });
              return;
            case 'answered':
              transition.emitSideEffect({ kind: 'closed' });
              return;
            case 'vetted':
              followFlow(state, { kind: 'openerKnown', origin: event.state.origin }, transition);
              return;
            case 'no-opener':
              followFlow(state, { kind: 'openerKnown', origin: null }, transition);
              return;
            case 'connecting':
              return;
          }
        },
        // The round's result goes to the page that opened the window, or is said as done when no page did.
        roundEnded({ flow }, { result }, { emitState, emitSideEffect }) {
          if (flow.round.page === null) {
            emitState({ kind: 'ended', screen: getStopScreen(flow, 'done-no-opener') });
            emitSideEffect({ kind: 'logged', line: 'sign-in window signed in with no opener' });
            return;
          }
          emitState({ kind: 'ended', screen: getSignInScreen(flow) });
          emitSideEffect({ kind: 'logged', line: 'sign-in window sends its result' });
          emitSideEffect({ kind: 'delivered', result });
        },
        cancelAsked: closeWindow,
        disposed: disposeWindow,
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

  const intents: WindowIntents = {
    continueWithStored() {
      machine.update({ kind: 'continueAsked' });
      return machine.await();
    },
    useAnotherAccount() {
      machine.update({ kind: 'anotherAsked' });
      return machine.await();
    },
    goOnWithoutPhone() {
      machine.update({ kind: 'goOnAsked' });
      return machine.await();
    },
    isValidPhrase(phrase) {
      // Only the phrase view's steps hold the check, so any other state has left that view or not shown it yet.
      const state = machine.state.get();
      return state.kind === 'live' && 'check' in state.flow && state.flow.check.toEntropy(phrase) !== null;
    },
    async importPhrase(phrase) {
      const asker = Symbol('asker');
      machine.update({ kind: 'importAsked', phrase, asker });
      await machine.await();
      const settled = machine.state.get();
      if (settled.kind === 'live' && settled.flow.kind === 'phraseRejected' && settled.flow.asker === asker) {
        throw settled.flow.error;
      }
    },
    closePhrase() {
      machine.update({ kind: 'closePhraseAsked' });
      return machine.await();
    },
    retry() {
      machine.update({ kind: 'retryAsked' });
      return machine.await();
    },
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
   * The first view once the opener is known, and Retry's after a step that failed. A page that knows a sign-in exists
   * elsewhere asked to take it, so the window sends it without offering Continue first.
   */
  function decide(step: Step, transition: Transition<FlowMachine>): void {
    const { round, shown } = step;
    switch (round.intent) {
      case 'phrase':
        transition.emitState({ kind: 'loadingPhrase', round, shown });
        transition.update(loadPhrase().then(check => ({ kind: 'phraseLoaded', check }), mapWorkFailure));
        return;
      case 'resume':
        transition.emitSideEffect({ kind: 'logged', line: 'sign-in window resumes the stored sign-in' });
        transition.emitState({ kind: 'readingToSend', round, shown });
        transition.update(toStoredRead(reads.readStored()));
        return;
      case 'signin':
        readToOffer(step, transition);
        return;
    }
  }

  function readToOffer({ round, shown }: Step, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'readingToOffer', round, shown });
    update(toStoredRead(reads.readStored()));
  }

  /** Retry over a failed pairing shows the spinner while the store decides again what to offer. */
  function retryPairing(round: Round, transition: Transition<FlowMachine>): void {
    readToOffer({ round: { ...round, pairing: SPINNER }, shown: { view: 'pairing' } }, transition);
  }

  /** Shows the pairing and logs in. The login waits on the phone, so it answers outside `await()`. */
  function pair(round: Round, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'loggingIn', round: { ...round, pairing: SPINNER }, shown: { view: 'pairing' } });
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
   * Signs out, telling the phone, or tells it again from what an `untold` sign-out left. A failure is reported by the
   * sign-out itself. The phone keeps this browser listed until it is told, so the window goes on only once it was, or
   * the user chooses to.
   */
  function logOut(
    { round, shown }: Continued,
    untold: UntoldLogout | null,
    { emitState, emitSideEffect, update }: Transition<FlowMachine>,
  ): void {
    emitSideEffect({ kind: 'logged', line: 'sign-in window uses another account' });
    emitState({ kind: 'loggingOut', round, shown });
    const outcome = untold === null ? signOut.signOut() : signOut.tellAgain(untold);
    update(outcome.then(told => ({ kind: 'loggedOut', outcome: told }), mapWorkFailure));
  }

  /** The rest of Use another account once the paired session ended: forget the wallet and pair. */
  function leaveForAnother({ round, shown }: Continued, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'checkingSignedOut', round, shown });
    // A store that cannot be read may still hold the session, so the window does not go on over it.
    update(reads.isSessionGone().then(gone => ({ kind: gone ? 'sessionGone' : 'sessionHeld' }), mapWorkFailure));
  }
}

function getScreen(state: State): SignInScreen {
  switch (state.kind) {
    case 'live':
      return getSignInScreen(state.flow);
    case 'refused':
    case 'ended':
    case 'disposed':
      return state.screen;
  }
}

function toStoredRead(read: Promise<SessionResult>): Promise<Event> {
  return read.then(stored => ({ kind: 'storedRead', stored }), mapWorkFailure);
}

function mapWorkFailure(error: unknown): Extract<Event, { kind: 'workFailed' }> {
  return { kind: 'workFailed', error };
}
