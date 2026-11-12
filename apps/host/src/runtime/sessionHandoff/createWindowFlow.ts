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
import type {
  ContinueOffer,
  OfferedAccount,
  SignInScreen,
  WindowFailure,
  WindowIntents,
} from '../../state/sessionWindowState.js';
import type { AuthCommands } from '../createAuthController.js';
import type { LogoutOutcome } from '../createPageSignOut.js';
import { reportLocalWalletFailure, reportWalletFailure } from '../walletFailure.js';
import { getLoginFailureView } from '../getLoginFailureView.js';
import { authViews } from '../session/authViews.js';
import type { DotliAuthState } from '../session/types.js';
import type { HostCoreStorage } from '../session/createCoreStorage.js';
import type { SignInFlag } from '../session/signInFlag.js';
import { getLocalSessionUiState } from '../session/getLocalSessionUiState.js';
import { parseUiStateCache, type TruapiSessionUiState } from '../session/parseUiStateCache.js';
import type { SignInIntent } from './parseWindowRequest.js';
import type { Responder, ResponderState } from './createResponder.js';
import type { SessionResult } from './parseSessionResult.js';

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
  commands: AuthCommands;
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

type GetResponderScreenParams = {
  /** The pairing the screen carries, a spinner by default. */
  pairing?: PairingView;
};

/** A closed set, so the metric's `reason` tag stays bounded. */
type StepName = 'decide' | 'continue' | 'another' | 'phrase' | 'back' | 'pairing' | 'finish';

/** What a round keeps from its opening, with how far its pairing got, which every view carries. */
type Round = {
  intent: SignInIntent;
  /** The page the window signs in for, null when no page opened the window, so nobody waits for the result. */
  page: string | null;
  pairing: PairingView;
};

/** The view a step leaves on show: any of the round's, or Continue's with what it offered and the failure on it. */
type Shown =
  | { view: Exclude<SignInScreen['view'], 'continue'> }
  | { view: 'continue'; offer: ContinueOffer; failure: WindowFailure | null };

/** A step that leaves on show the view it was asked on. The page and the pairing come from the round. */
type Step = { round: Round; shown: Shown };

/**
 * What Continue offers, with the stored sign-in it was read from. `offer` is derived from `stored` once, so the views
 * read it without a null case.
 */
type Offered = { stored: SessionResult; offer: ContinueOffer };

/** A step of Continue's view, which keeps on show what was offered and the failure on show when it was asked. */
type Continued = { round: Round; offered: Offered; failure: WindowFailure | null };

/**
 * The round's flow, from the hello it waits for to the end of its round. Each step that waits on work is a kind of its
 * own. `loggingIn`, `loginFailing` and `loggingInThenRetry` run the window's login, which waits on the phone and so
 * answers through its callback: `loginFailing` shows how the pairing failed while the login still runs, and
 * `loggingInThenRetry` is a Retry pressed then, which decides once the login answered.
 */
type Flow =
  | { kind: 'waiting'; pairing: PairingView }
  | (Step & { kind: 'loadingPhrase' })
  | (Step & { kind: 'readingToOffer' })
  | (Step & { kind: 'readingToSend' })
  | (Step & { kind: 'clearingFlag' })
  | (Step & { kind: 'storingFlag'; stored: SessionResult })
  | { kind: 'continue'; round: Round; offered: Offered; failure: Exclude<WindowFailure, 'phone'> | null }
  | {
      kind: 'phoneUntold';
      round: Round;
      offered: Offered;
      /**
       * The logout's own retry, which tells the phone of the same session once more. `LogoutOutcome` answers an untold
       * phone with it, and only Try again calls it.
       */
      tellAgain: Extract<LogoutOutcome, { phone: 'untold' }>['tellAgain'];
    }
  | (Continued & { kind: 'readingForContinue' })
  | (Continued & { kind: 'loggingOut' })
  | (Continued & { kind: 'checkingSignedOut' })
  | (Continued & { kind: 'forgettingWallet' })
  | (Continued & { kind: 'readingAfterForget' })
  | { kind: 'phrase'; round: Round; check: PhraseCheck }
  | { kind: 'phraseRejected'; round: Round; check: PhraseCheck; asker: symbol; error: Error }
  | { kind: 'goingBack'; round: Round }
  | { kind: 'savingPhrase'; round: Round; check: PhraseCheck; asker: symbol; entropy: Uint8Array }
  | { kind: 'readingAfterPhrase'; round: Round; entropy: Uint8Array }
  | { kind: 'loggingIn'; round: Round }
  | { kind: 'loginFailing'; round: Round }
  | { kind: 'loggingInThenRetry'; round: Round }
  | { kind: 'pairingIdle'; round: Round }
  | { kind: 'finishing'; round: Round; account: TruapiSessionUiState }
  | { kind: 'cachingAccount'; round: Round; result: SessionResult }
  | { kind: 'failed'; round: Round };

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
  | { kind: 'saveFailed'; error: Error }
  | { kind: 'sessionRead'; session: SessionResult['session'] }
  | { kind: 'loginPaired'; account: TruapiSessionUiState }
  | { kind: 'loginEnded'; how: 'failed' | 'cancelled' }
  | { kind: 'pairedRead'; blob: string; localWallet: SessionResult['localWallet'] }
  | { kind: 'accountCached' }
  | { kind: 'workFailed'; error: unknown }
  | { kind: 'roundEnded'; result: SessionResult }
  | { kind: 'doneWithoutOpener' };

type Effect = { kind: 'stepFailed'; name: StepName; error: unknown } | { kind: 'logged'; line: string };

type WindowMachine = MachineTypes<State, Event, Effect>;

type FlowMachine = MachineTypes<Flow, Event, Effect>;

/** The events the flow hears. The window's own handle the round's end and the window's life. */
type FlowEventKind = Exclude<
  Event['kind'],
  'responderMoved' | 'disposed' | 'cancelAsked' | 'roundEnded' | 'doneWithoutOpener'
>;

/** The steps whose failure leaves the failed view, since their view cannot go on. */
type FailingKind =
  | 'readingToOffer'
  | 'readingToSend'
  | 'goingBack'
  | 'readingForContinue'
  | 'readingAfterPhrase'
  | 'loggingIn'
  | 'loginFailing'
  | 'loggingInThenRetry'
  | 'finishing'
  | 'cachingAccount';

/** The step each failing kind reports its failure under. */
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
} satisfies Record<FailingKind, StepName>;

const SPINNER: PairingView = { kind: 'spinner' };

/** What a login the core ended says, when the core said nothing of its own about it. */
const LOGIN_ENDED: Record<'failed' | 'cancelled', PairingView> = {
  failed: getLoginFailureView('Other', 'The sign-in did not complete'),
  cancelled: getLoginFailureView('Other', 'The sign-in was cancelled'),
};

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
  store,
  wallet,
  loadPhrase,
  intent: requestIntent,
  pageLabel,
  deliver,
  close,
}: WindowFlowParams) {
  // Every state hears Cancel, so a step under way never holds the window open. A pairing given up stored nothing and so
  // raised no flag.
  const closeWindow: HandlerOf<WindowMachine, 'live' | 'refused' | 'ended', 'cancelAsked'> = () => {
    close();
  };
  const closeOnAnswer: HandlerOf<WindowMachine, 'refused' | 'ended', 'responderMoved'> = (_state, event) => {
    if (event.state.kind === 'answered') {
      close();
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
    emitState({ kind: 'failed', round: state.round });
  };
  /** Use another account failed, so Continue offers what it offered with the failure on show. */
  const failAnother: HandlerOf<FlowMachine, 'loggingOut' | 'checkingSignedOut' | 'readingAfterForget', 'workFailed'> = (
    { round, offered },
    { error },
    { emitState, emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'stepFailed', name: 'another', error });
    emitState({ kind: 'continue', round, offered, failure: 'step' });
  };
  // Only a running login is followed, so a failure a login left stays on show whatever the auth state does. The login's
  // answer, not the auth state, decides how a pairing ends.
  const followLogin: HandlerOf<FlowMachine, 'loggingIn' | 'loginFailing', 'authChanged'> = (
    { round },
    { auth: changed },
    { emitState },
  ) => {
    const pairing = getPairingView(round.pairing, changed);
    const next = { ...round, pairing };
    emitState(pairing.kind === 'error' ? { kind: 'loginFailing', round: next } : { kind: 'loggingIn', round: next });
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
    { round },
    { account },
    { emitState, update },
  ) => {
    emitState({ kind: 'finishing', round, account });
    update(
      Promise.all([readBlob(), readWallet()]).then(
        ([blob, localWallet]) =>
          blob === null
            ? mapWorkFailure(new Error('The paired session is no longer stored'))
            : { kind: 'pairedRead', blob, localWallet },
        mapWorkFailure,
      ),
    );
  };
  const importPhrase: HandlerOf<FlowMachine, 'phrase' | 'phraseRejected', 'importAsked'> = (
    { round, check },
    { phrase, asker },
    { emitState, emitSideEffect, update },
  ) => {
    const entropy = check.toEntropy(phrase);
    if (entropy === null) {
      const error = new Error('Not a valid recovery phrase');
      emitSideEffect({ kind: 'stepFailed', name: 'phrase', error });
      emitState({ kind: 'phraseRejected', round, check, asker, error });
      return;
    }
    emitState({ kind: 'savingPhrase', round, check, asker, entropy });
    update(
      // Only a local wallet core reads the identity, and a window that takes a phrase pairs, so it saves none.
      signIns
        .store(() => wallet.save(entropy, null))
        .then(
          () => ({ kind: 'phraseSaved' }),
          (error: unknown) => {
            const failure = new Error('The recovery phrase wallet could not be saved', { cause: error });
            reportLocalWalletFailure(failure, 'save');
            return { kind: 'saveFailed', error: failure };
          },
        ),
    );
  };
  const goBack: HandlerOf<FlowMachine, 'phrase' | 'phraseRejected', 'closePhraseAsked'> = (
    { round },
    _event,
    { emitState, update },
  ) => {
    emitState({ kind: 'goingBack', round });
    update(readStored().then(stored => ({ kind: 'storedRead', stored }), mapWorkFailure));
  };

  const followFlow = nest<WindowMachine, 'live', FlowMachine, FlowEventKind>({
    find: ({ flow }) => flow,
    store: (state, _event, flow) => ({ ...state, flow }),
    handlers: {
      waiting: {
        openerKnown({ pairing }, { origin }, transition) {
          const round =
            origin === null
              ? { intent: getNoOpenerIntent(requestIntent), page: null, pairing }
              : { intent: requestIntent, page: pageLabel(origin), pairing };
          decide({ round, shown: { view: 'connecting' } }, transition);
        },
      },
      loadingPhrase: {
        phraseLoaded({ round }, { check }, { emitState }) {
          emitState({ kind: 'phrase', round, check });
        },
        // The miss is reported as a missed chunk where it was mapped, so the step itself ends without failing.
        workFailed({ round }, _event, { emitState }) {
          emitState({ kind: 'failed', round });
        },
      },
      readingToOffer: {
        storedRead(state, { stored }, transition) {
          offerOrPair(state, stored, transition);
        },
        workFailed: failStep,
      },
      readingToSend: {
        storedRead(state, { stored }, transition) {
          send(state, stored, transition);
        },
        workFailed: failStep,
      },
      clearingFlag: {
        flagLanded({ round }, _event, transition) {
          pair(round, transition);
        },
      },
      storingFlag: {
        flagLanded({ round, stored }, _event, transition) {
          endRound(round, stored, transition);
        },
      },
      continue: {
        continueAsked({ round, offered, failure }, _event, { emitState, update }) {
          emitState({ kind: 'readingForContinue', round, offered, failure });
          update(
            readStoredForContinue(offered.stored).then(stored => ({ kind: 'storedRead', stored }), mapWorkFailure),
          );
        },
        anotherAsked(state, _event, transition) {
          logOut(state, () => commands.logout(), transition);
        },
      },
      phoneUntold: {
        // Try again on that failure tells the same session once more.
        anotherAsked({ round, offered, tellAgain }, _event, transition) {
          logOut({ round, offered, failure: 'phone' }, tellAgain, transition);
        },
        goOnAsked({ round, offered }, _event, transition) {
          transition.emitSideEffect({ kind: 'logged', line: 'sign-in window goes on with the phone not told' });
          leaveForAnother({ round, offered, failure: 'phone' }, transition);
        },
      },
      readingForContinue: {
        storedRead(state, { stored }, transition) {
          send(
            { round: state.round, shown: { view: 'continue', offer: state.offered.offer, failure: state.failure } },
            stored,
            transition,
          );
        },
        workFailed: failStep,
      },
      loggingOut: {
        loggedOut(state, { outcome }, transition) {
          switch (outcome.phone) {
            case 'untold':
              transition.emitState({
                kind: 'phoneUntold',
                round: state.round,
                offered: state.offered,
                tellAgain: outcome.tellAgain,
              });
              return;
            case 'told':
              leaveForAnother(state, transition);
              return;
          }
        },
        workFailed: failAnother,
      },
      checkingSignedOut: {
        sessionHeld({ round, offered }, _event, { emitState }) {
          emitState({ kind: 'continue', round, offered, failure: 'sign-out' });
        },
        sessionGone({ round, offered, failure }, _event, { emitState, update }) {
          emitState({ kind: 'forgettingWallet', round, offered, failure });
          update(
            signIns
              .clear({
                drop: async () => {
                  await wallet.forget();
                  return true;
                },
              })
              .then(
                () => ({ kind: 'walletForgotten' }),
                (error: unknown) => {
                  // The wallet is still stored, so the flag stays up for it.
                  reportLocalWalletFailure(
                    new Error('Local wallet could not be forgotten', { cause: error }),
                    'forget',
                  );
                  return mapWorkFailure(error);
                },
              ),
          );
        },
        workFailed: failAnother,
      },
      forgettingWallet: {
        walletForgotten({ round }, _event, transition) {
          pair(round, transition);
        },
        workFailed({ round, offered, failure }, _event, { emitState, update }) {
          emitState({ kind: 'readingAfterForget', round, offered, failure });
          update(readStored().then(stored => ({ kind: 'storedRead', stored }), mapWorkFailure));
        },
      },
      readingAfterForget: {
        storedRead({ round }, { stored }, { emitState }) {
          const offer = getContinueOffer(stored);
          // A wallet that cannot be read may still be stored, so the window starts no pairing over it.
          if (offer === null) {
            emitState({ kind: 'failed', round });
            return;
          }
          emitState({ kind: 'continue', round, offered: { stored, offer }, failure: 'sign-out' });
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
        storedRead(state, { stored }, transition) {
          offerOrPair({ round: state.round, shown: { view: 'phrase' } }, stored, transition);
        },
        workFailed: failStep,
      },
      savingPhrase: {
        phraseSaved({ round, entropy }, _event, { emitState, emitSideEffect, update }) {
          emitSideEffect({ kind: 'logged', line: 'sign-in window saved a recovery phrase wallet' });
          emitState({ kind: 'readingAfterPhrase', round, entropy });
          // A paired session stays, so the user can switch back to it. A session that cannot be read now fails the
          // step on the failed view, since the form saying the save failed would be wrong.
          update(
            readSession().then(
              session => ({ kind: 'sessionRead', session }),
              (error: unknown) =>
                mapWorkFailure(
                  new Error('The paired session could not be read after the wallet saved', { cause: error }),
                ),
            ),
          );
        },
        // The form shows the failure from the import's rejection, which is reported before it rejects.
        saveFailed({ round, check, asker }, { error }, { emitState }) {
          emitState({ kind: 'phraseRejected', round, check, asker, error });
        },
      },
      readingAfterPhrase: {
        sessionRead({ round, entropy }, { session }, transition) {
          endRound(round, { session, localWallet: { entropy, identity: null } }, transition);
        },
        workFailed: failStep,
      },
      loggingIn: {
        // A login that ends without a sign-in leaves a failure on show for Retry, one that says how it ended, so no
        // dead code stays up.
        loginEnded({ round }, { how }, { emitState }) {
          emitState({ kind: 'pairingIdle', round: { ...round, pairing: LOGIN_ENDED[how] } });
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followLogin,
      },
      loginFailing: {
        // The core's own failure stays on show for Retry.
        loginEnded({ round }, _event, { emitState }) {
          emitState({ kind: 'pairingIdle', round });
        },
        // Retry decides only once the login under way answered, so it never lands in the round of the failed one.
        retryAsked({ round }, _event, { emitState }) {
          emitState({ kind: 'loggingInThenRetry', round });
        },
        loginPaired: finishPairing,
        workFailed: failStep,
        authChanged: followLogin,
      },
      loggingInThenRetry: {
        loginEnded(state, _event, transition) {
          retryPairing(state.round, transition);
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
        pairedRead({ round, account }, { blob, localWallet }, { emitState, update }) {
          // From the account the login answered with. The window runs no session state to cache it, so it caches it
          // here, for a page that shows the main store without a core of its own and for a later Continue.
          const uiState = JSON.stringify(account);
          emitState({ kind: 'cachingAccount', round, result: { session: { blob, uiState }, localWallet } });
          update(store.writeUiCache(uiState).then(() => ({ kind: 'accountCached' }), mapWorkFailure));
        },
        workFailed: failStep,
        authChanged: followAuth,
      },
      cachingAccount: {
        accountCached({ round, result }, _event, transition) {
          endRound(round, result, transition);
        },
        workFailed: failStep,
        authChanged: followAuth,
      },
      failed: {
        // No login runs here, so whatever pairing is on show was left by one that ended, and gives way to the spinner.
        retryAsked({ round }, _event, transition) {
          const next = { ...round, pairing: SPINNER };
          decide({ round: next, shown: { view: 'failed' } }, transition);
        },
      },
    },
  });

  const machine = createStateMachine<WindowMachine>({
    initial: { kind: 'live', flow: { kind: 'waiting', pairing: getPairingView(SPINNER, auth.get()) } },
    handlers: {
      live: {
        responderMoved(state, event, transition) {
          switch (event.state.kind) {
            case 'refused':
              transition.emitState({ kind: 'refused', screen: getStopScreen(state.flow, 'refused') });
              return;
            case 'answered':
              close();
              return;
            case 'vetted':
              transition.update({ kind: 'openerKnown', origin: event.state.origin });
              return;
            case 'no-opener':
              transition.update({ kind: 'openerKnown', origin: null });
              return;
            case 'connecting':
              return;
          }
        },
        roundEnded(state, { result }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended', screen: getScreen(state) });
          emitSideEffect({ kind: 'logged', line: 'sign-in window sends its result' });
          deliver(result);
        },
        doneWithoutOpener({ flow }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended', screen: getStopScreen(flow, 'done-no-opener') });
          emitSideEffect({ kind: 'logged', line: 'sign-in window signed in with no opener' });
        },
        cancelAsked: closeWindow,
        disposed: disposeWindow,
        openerKnown: followFlow,
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
        saveFailed: followFlow,
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
        case 'logged':
          report.log.event(effect.line);
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
      const check = getPhraseCheck(machine.state.get());
      return check !== null && check.toEntropy(phrase) !== null;
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

  /** The check while the phrase view is open, else null: any other state has left that view, or not shown it yet. */
  function getPhraseCheck(state: State): PhraseCheck | null {
    if (state.kind !== 'live') {
      return null;
    }
    switch (state.flow.kind) {
      case 'phrase':
      case 'phraseRejected':
      case 'savingPhrase':
        return state.flow.check;
      case 'waiting':
      case 'loadingPhrase':
      case 'readingToOffer':
      case 'readingToSend':
      case 'clearingFlag':
      case 'storingFlag':
      case 'continue':
      case 'phoneUntold':
      case 'readingForContinue':
      case 'loggingOut':
      case 'checkingSignedOut':
      case 'forgettingWallet':
      case 'readingAfterForget':
      case 'goingBack':
      case 'readingAfterPhrase':
      case 'loggingIn':
      case 'loginFailing':
      case 'loggingInThenRetry':
      case 'pairingIdle':
      case 'finishing':
      case 'cachingAccount':
      case 'failed':
        return null;
    }
  }

  /** The stored session blob. A store that cannot be read may still hold one, so the read fails the step. */
  async function readBlob(): Promise<string | null> {
    const read = await store.readSession();
    if (read.status === 'failed') {
      throw new Error('The main store could not be read', { cause: read.error });
    }
    return read.blob;
  }

  async function readSession(): Promise<SessionResult['session']> {
    // The cache read never rejects, so only a failed blob read fails the step.
    const [blob, uiState] = await Promise.all([readBlob(), store.readUiCache()]);
    return blob === null ? null : { blob, uiState };
  }

  /** A wallet that cannot be read is reported and taken as none, so the window still offers a session or pairs. */
  async function readWallet(): Promise<SessionResult['localWallet']> {
    try {
      const read = await wallet.read();
      return read.status === 'ok' ? { entropy: read.entropy, identity: read.identity } : null;
    } catch (error) {
      reportLocalWalletFailure(error, 'read');
      return null;
    }
  }

  /** What the main store holds, as the result carries it. */
  async function readStored(): Promise<SessionResult> {
    const [session, localWallet] = await Promise.all([readSession(), readWallet()]);
    return { session, localWallet };
  }

  /**
   * What the main store holds now, for Continue over `offered`. A sign-out on another page clears the session and the
   * wallet, so those are read again. The cached account goes with the session it was read for.
   */
  async function readStoredForContinue(offered: SessionResult): Promise<SessionResult> {
    const [blob, localWallet] = await Promise.all([readBlob(), readWallet()]);
    if (blob === null) {
      return { session: null, localWallet };
    }
    const uiState = blob === offered.session?.blob ? offered.session.uiState : await store.readUiCache();
    return { session: { blob, uiState }, localWallet };
  }

  /**
   * The first view once the opener is known, and Retry's after a step that failed. A page that knows a sign-in exists
   * elsewhere asked to take it, so the window sends it without offering Continue first.
   */
  function decide(step: Step, transition: Transition<FlowMachine>): void {
    const { round, shown } = step;
    switch (round.intent) {
      case 'phrase':
        transition.emitState({ kind: 'loadingPhrase', round, shown });
        transition.update(
          loadPhrase().then(
            check => ({ kind: 'phraseLoaded', check }),
            (error: unknown) => {
              // A module that could not load is a missed chunk, reported here once.
              reportLazyMiss({ report, step: 'phrase_import', error });
              return mapWorkFailure(error);
            },
          ),
        );
        return;
      case 'resume':
        transition.emitSideEffect({ kind: 'logged', line: 'sign-in window resumes the stored sign-in' });
        transition.emitState({ kind: 'readingToSend', round, shown });
        transition.update(readStored().then(stored => ({ kind: 'storedRead', stored }), mapWorkFailure));
        return;
      case 'signin':
        readToOffer(step, transition);
        return;
    }
  }

  function readToOffer({ round, shown }: Step, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'readingToOffer', round, shown });
    update(readStored().then(stored => ({ kind: 'storedRead', stored }), mapWorkFailure));
  }

  /** Retry over a failed pairing shows the spinner while the store decides again what to offer. */
  function retryPairing(round: Round, transition: Transition<FlowMachine>): void {
    const next = { ...round, pairing: SPINNER };
    readToOffer({ round: next, shown: { view: 'pairing' } }, transition);
  }

  /**
   * Offers what the store holds, else pairs. With nothing stored, a flag left set claims a sign-in that is gone, and
   * the keeper drops it only while the store is still empty, so a pairing under way that stores meanwhile keeps it.
   */
  function offerOrPair(
    { round, shown }: Step,
    stored: SessionResult,
    { emitState, update }: Transition<FlowMachine>,
  ): void {
    const offer = getContinueOffer(stored);
    if (offer !== null) {
      emitState({ kind: 'continue', round, offered: { stored, offer }, failure: null });
      return;
    }
    emitState({ kind: 'clearingFlag', round, shown });
    // Never rejects, since no drop runs.
    update(signIns.clear().then(() => ({ kind: 'flagLanded' })));
  }

  /**
   * Sends what the store holds, with the flag landed first, since the page reads it as it takes the result. A store
   * with nothing to send, such as a flag left set over an empty store, drops the flag and pairs.
   */
  function send(step: Step, stored: SessionResult, transition: Transition<FlowMachine>): void {
    if (getContinueOffer(stored) === null) {
      offerOrPair(step, stored, transition);
      return;
    }
    transition.emitState({ kind: 'storingFlag', round: step.round, shown: step.shown, stored });
    // Never rejects, since the write does nothing.
    transition.update(signIns.store(noop).then(() => ({ kind: 'flagLanded' })));
  }

  /** Shows the pairing and logs in. The login waits on the phone, so it answers through its callback. */
  function pair(round: Round, { emitState, update }: Transition<FlowMachine>): void {
    emitState({ kind: 'loggingIn', round: { ...round, pairing: SPINNER } });
    void commands.login().then(
      outcome => {
        update(
          outcome.kind === 'paired'
            ? { kind: 'loginPaired', account: outcome.account }
            : { kind: 'loginEnded', how: outcome.kind },
        );
      },
      (error: unknown) => {
        update(mapWorkFailure(error));
      },
    );
  }

  /**
   * Tells the phone and clears the paired session. A failure is reported by the logout itself. The phone keeps this
   * browser listed until it is told, so the window goes on only once it was, or the user chooses to.
   */
  function logOut(
    { round, offered, failure }: Continued,
    startLogout: () => Promise<LogoutOutcome>,
    { emitState, emitSideEffect, update }: Transition<FlowMachine>,
  ): void {
    emitSideEffect({ kind: 'logged', line: 'sign-in window uses another account' });
    emitState({ kind: 'loggingOut', round, offered, failure });
    update(startLogout().then(outcome => ({ kind: 'loggedOut', outcome }), mapWorkFailure));
  }

  /** The rest of Use another account once the paired session ended: forget the wallet and pair. */
  function leaveForAnother(
    { round, offered, failure }: Continued,
    { emitState, update }: Transition<FlowMachine>,
  ): void {
    emitState({ kind: 'checkingSignedOut', round, offered, failure });
    // A store that cannot be read may still hold the session, so the window does not go on over it.
    update(
      store
        .readSession()
        .then(
          read => (read.status === 'ok' && read.blob === null ? { kind: 'sessionGone' } : { kind: 'sessionHeld' }),
          mapWorkFailure,
        ),
    );
  }

  /** Ends the round with what the store holds: handed to `deliver`, or said as done when no page opened the window. */
  function endRound({ page }: Round, result: SessionResult, { update }: Transition<FlowMachine>): void {
    update(page === null ? { kind: 'doneWithoutOpener' } : { kind: 'roundEnded', result });
  }
}

/** What the window shows before its flow decides anything: it waits on its opener, or turned it away. */
export function getResponderScreen(
  state: ResponderState,
  { pairing = SPINNER }: GetResponderScreenParams = {},
): SignInScreen {
  return { view: getResponderView(state), pageHost: null, failure: null, pairing };
}

function getResponderView(state: ResponderState): 'refused' | 'connecting' {
  switch (state.kind) {
    case 'refused':
      return 'refused';
    case 'connecting':
    case 'vetted':
    case 'no-opener':
    case 'answered':
      return 'connecting';
  }
}

/** The intent a window with no opener starts with: the phrase view, or else a sign-in, since nobody waits to resume. */
function getNoOpenerIntent(intent: SignInIntent): SignInIntent {
  switch (intent) {
    case 'phrase':
      return 'phrase';
    case 'signin':
    case 'resume':
      return 'signin';
  }
}

function getScreen(state: State): SignInScreen {
  switch (state.kind) {
    case 'live':
      return getFlowScreen(state.flow);
    case 'refused':
    case 'ended':
    case 'disposed':
      return state.screen;
  }
}

/** The view each kind shows. A step that waits on work keeps the view it was asked on. */
function getFlowScreen(flow: Flow): SignInScreen {
  switch (flow.kind) {
    case 'waiting':
      return { view: 'connecting', pageHost: null, failure: null, pairing: flow.pairing };
    case 'loadingPhrase':
    case 'readingToOffer':
    case 'readingToSend':
    case 'clearingFlag':
    case 'storingFlag':
      return getShownScreen(flow.round, flow.shown);
    case 'continue':
    case 'readingForContinue':
    case 'loggingOut':
    case 'checkingSignedOut':
    case 'forgettingWallet':
    case 'readingAfterForget':
      return getContinueScreen(flow, flow.failure);
    case 'phoneUntold':
      return getContinueScreen(flow, 'phone');
    case 'phrase':
    case 'phraseRejected':
    case 'goingBack':
    case 'savingPhrase':
    case 'readingAfterPhrase':
      return getRoundScreen('phrase', flow.round);
    case 'loggingIn':
    case 'loginFailing':
    case 'loggingInThenRetry':
    case 'pairingIdle':
    case 'finishing':
    case 'cachingAccount':
      return getRoundScreen('pairing', flow.round);
    case 'failed':
      return getRoundScreen('failed', flow.round);
  }
}

function getShownScreen(round: Round, shown: Shown): SignInScreen {
  if (shown.view === 'continue') {
    return {
      view: 'continue',
      offer: shown.offer,
      pageHost: round.page,
      failure: shown.failure,
      pairing: round.pairing,
    };
  }
  return getRoundScreen(shown.view, round);
}

function getContinueScreen(
  { round, offered }: Pick<Continued, 'round' | 'offered'>,
  failure: WindowFailure | null,
): SignInScreen {
  return { view: 'continue', offer: offered.offer, pageHost: round.page, failure, pairing: round.pairing };
}

/** A view of the round with nothing failed on it. */
function getRoundScreen(view: Exclude<SignInScreen['view'], 'continue'>, round: Round): SignInScreen {
  return { view, pageHost: round.page, failure: null, pairing: round.pairing };
}

/** The view the window stops on, which keeps the page and the pairing the flow showed. */
function getStopScreen(flow: Flow, view: 'refused' | 'done-no-opener'): SignInScreen {
  const { pageHost, pairing } = getFlowScreen(flow);
  return { view, pageHost, failure: null, pairing };
}

function mapWorkFailure(error: unknown): Extract<Event, { kind: 'workFailed' }> {
  return { kind: 'workFailed', error };
}

/** How far the core's pairing got. A disconnect leaves what is on show, so a failure stays up for Retry. */
function getPairingView(shown: PairingView, state: DotliAuthState): PairingView {
  const step = authViews.getLoginStep(state);
  switch (step?.step) {
    case 'pairing':
      return step.pairing.deeplink ? { kind: 'pairing', payload: step.pairing.deeplink } : SPINNER;
    case 'authenticating':
      return { kind: 'authenticating' };
    case 'failed':
      return getLoginFailureView(step.kind, step.reason);
    case undefined:
      return authViews.getSignedInSession(state) === null ? shown : SPINNER;
  }
}

function getOfferedAccount(uiState: TruapiSessionUiState | null): OfferedAccount | null {
  if (uiState === null) {
    return null;
  }
  const { connected, ...account } = uiState;
  return connected ? account : null;
}

function getContinueOffer(stored: SessionResult): ContinueOffer | null {
  if (stored.localWallet !== null) {
    const identity = stored.localWallet.identity;
    return { wallet: 'local', account: identity === null ? null : getOfferedAccount(getLocalSessionUiState(identity)) };
  }
  if (stored.session !== null) {
    const uiState = stored.session.uiState;
    return { wallet: 'paired', account: uiState === null ? null : getOfferedAccount(parseUiStateCache(uiState)) };
  }
  return null;
}
