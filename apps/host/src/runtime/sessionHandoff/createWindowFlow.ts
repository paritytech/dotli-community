// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in window shows and does once it knows its opener. It decides from the main store, never from the
// opener, offers what is stored or pairs, and delivers what the store holds, at once for a page that resumes a sign-in
// it knows exists. It never answers the opener itself. The request picks only which of these the window starts with.
// Every sign-in it stores or clears, its core's included, goes through the window's one flag keeper, which raises the
// flag first and drops it once the store holds none, so a pairing given up leaves no flag. The window runs no sign-in
// modal: it pairs on its core itself and shows how far the pairing got.

import type { LocalWalletIdentity, LocalWalletReadResult } from '@dotli/protocol';
import { spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, createSyncStore, log, isShallowEqual, type ReadableStore } from '@dotli/shared';
import { reportLazyMiss } from '../../lazyMiss.js';
import type { PairingView } from '../../state/authModalState.js';
import type {
  ContinueOffer,
  OfferedAccount,
  SignInScreen,
  WindowFailure,
  WindowIntents,
  WindowView,
} from '../../state/sessionWindowState.js';
import type { AuthCommands } from '../createAuthCommands.js';
import type { LogoutOutcome } from '../createPageSignOut.js';
import { reportLocalWalletFailure, reportWalletFailure } from '../walletFailure.js';
import { getLoginFailureView } from '../getLoginFailureView.js';
import type { DotliAuthState } from '../session/types.js';
import type { HostCoreStorage } from '../session/createCoreStorage.js';
import type { SignInFlag } from '../session/signInFlag.js';
import { getLocalSessionUiState } from '../session/getLocalSessionUiState.js';
import { parseUiStateCache, type TruapiSessionUiState } from '../session/parseUiStateCache.js';
import type { SignInIntent } from './parseWindowRequest.js';
import type { Responder, ResponderState } from './createResponder.js';
import type { SessionResult } from './parseSessionResult.js';

export type WindowFlow = ReturnType<typeof createWindowFlow>;

/** The recovery phrase check the phrase view loads before it shows. */
export type PhraseCheck = {
  /** The phrase's entropy, or null for anything that is not a recovery phrase. */
  toEntropy: (phrase: string) => Uint8Array | null;
};

export type WindowFlowParams = {
  /** Watched only, so the flow learns where the round stands and never answers the opener itself. */
  responder: Pick<Responder<unknown>, 'state' | 'subscribe'>;
  /** The page's one flag keeper, so the flow's flag writes and the store writes stay in order. */
  signIns: SignInFlag;
  auth: ReadableStore<DotliAuthState>;
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
  /** Takes what the store holds once the flow ended its round with a vetted opener. */
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

/**
 * What a failed step leaves on show: the failed view, for a step whose view cannot go on, or a failure on its view.
 */
type StepFailure = 'view' | 'step';

/**
 * The flow's phase in its round: `waiting` for a vetted hello, `open` once the flow decided with its intent, and
 * `ended` once it delivered, after which nothing may change the store.
 */
type Phase = { kind: 'waiting' } | { kind: 'open'; intent: SignInIntent } | { kind: 'ended' };

/** A view to show with what is its own, which only Continue has. */
type NextView = { view: 'continue'; offer: ContinueOffer } | { view: Exclude<SignInScreen['view'], 'continue'> };

/** What every sign-in view carries over to the next. */
type Carried = Pick<SignInScreen, 'pageHost' | 'failure' | 'pairing'>;

type GetNextScreenParams = {
  /** The screen on show, whose carried fields go over. */
  shown: SignInScreen;
  next: NextView;
  /** The carried fields that change. */
  change: Partial<Carried>;
};

type RunStepParams = {
  name: StepName;
  /** The step's work. Rejects when the step failed. */
  run: () => Promise<void>;
  /** What a failure leaves on show. */
  failure: StepFailure;
};

type RunOnViewParams = RunStepParams & {
  /** The view the user asked on. */
  view: WindowView;
};

const STEPS = 'session_window';

/** The window's own logins, apart from the steps, since a login waits on the phone and must not hold up a step. */
const LOGINS = 'session_window_login';

const SPINNER: PairingView = { kind: 'spinner' };

/** What a login the core ended says, when the core said nothing of its own about it. */
const LOGIN_ENDED: Record<'failed' | 'cancelled', PairingView> = {
  failed: getLoginFailureView('Other', 'The sign-in did not complete'),
  cancelled: getLoginFailureView('Other', 'The sign-in was cancelled'),
};

/** The sign-in window's flow over `responder`, which starts deciding once the responder knows its opener. */
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
  const screen = createSyncStore<SignInScreen>({
    name: 'sessionWindowFlow',
    initial: getResponderScreen(responder.state(), { pairing: getPairingView(SPINNER, auth.get()) }),
    equals: isShallowEqual,
  });
  // One step at a time, so a second press waits for the first and finds the view it left.
  const steps = createAsyncTaskPool({ poolSize: 1 });
  let phase: Phase = { kind: 'waiting' };
  // What the Continue on show offers, as the store held it.
  let offered: SessionResult | null = null;
  // The retry of a sign-out the phone did not hear of, held only while that failure is on show.
  let tellAgain: (() => Promise<LogoutOutcome>) | null = null;
  // The phrase check, loaded before the phrase view shows. A debug-only feature, so no other view waits on it.
  let phraseCheck: PhraseCheck | null = null;

  function show(next: NextView): void {
    tellAgain = null;
    screen.set(getNextScreen({ shown: screen.get(), next, change: { failure: null } }));
  }

  /** Changes what the view on show carries, which keeps its own fields. */
  function change(fields: Partial<Carried>): void {
    const shown = screen.get();
    screen.set(getNextScreen({ shown, next: shown, change: fields }));
  }

  function fail(failure: WindowFailure): void {
    tellAgain = null;
    change({ failure });
  }

  /** A step whose view cannot go on, so the window says so and offers Retry. */
  function showFailed(): void {
    if (phase.kind !== 'ended') {
      show({ view: 'failed' });
    }
  }

  function showStepFailure(failure: StepFailure): void {
    switch (failure) {
      case 'view':
        showFailed();
        return;
      case 'step':
        fail('step');
        return;
    }
  }

  /** Never rejects: a failure is reported, and shown as `failure` says. */
  function runStep({ name, run, failure }: RunStepParams): Promise<void> {
    return steps.call(run, { pool: STEPS }).catch((error: unknown) => {
      reportStepFailure(error, name);
      showStepFailure(failure);
    });
  }

  /** Whether a step the user asked for on `view` still applies, as the window may have left that view or ended. */
  function isStillOn(view: WindowView): boolean {
    return phase.kind !== 'ended' && screen.get().view === view;
  }

  /** The phrase view's check while that view is on show, which it never is before the check loaded. */
  function getPhraseOnShow(): PhraseCheck | null {
    return isStillOn('phrase') ? phraseCheck : null;
  }

  /** A step the user asked for on `view`, which does nothing once the window left that view or ended. */
  function runOnView({ name, view, run, failure }: RunOnViewParams): Promise<void> {
    async function runWhileOnView(): Promise<void> {
      if (isStillOn(view)) {
        await run();
      }
    }
    return runStep({ name, run: runWhileOnView, failure });
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
    const blob = await readBlob();
    return blob === null ? null : { blob, uiState: await store.readUiCache() };
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
   * What the main store holds now, for Continue. A sign-out on another page clears the session and the wallet, so those
   * are read again. The cached account goes with the session it was read for.
   */
  async function readStoredForContinue(): Promise<SessionResult> {
    const [blob, localWallet] = await Promise.all([readBlob(), readWallet()]);
    if (blob === null) {
      return { session: null, localWallet };
    }
    const uiState = blob === offered?.session?.blob ? offered.session.uiState : await store.readUiCache();
    return { session: { blob, uiState }, localWallet };
  }

  /** Ends the round with what the store holds: handed to `deliver`, or said as done when no page opened the window. */
  function endRound(result: SessionResult): void {
    phase = { kind: 'ended' };
    if (responder.state().kind === 'no-opener') {
      log.event('sign-in window signed in with no opener', { flow: 'wallet' });
      show({ view: 'done-no-opener' });
      return;
    }
    log.event('sign-in window sends its result', { flow: 'wallet' });
    deliver(result);
  }

  /** Sends what the login paired, which the command answered only once the main store held it. */
  function finishPairing(account: TruapiSessionUiState): Promise<void> {
    return steps.call(
      async () => {
        if (phase.kind === 'ended') {
          return;
        }
        const [blob, localWallet] = await Promise.all([readBlob(), readWallet()]);
        if (blob === null) {
          throw new Error('The paired session is no longer stored');
        }
        // From the account the login answered with. The window runs no session state to cache it, so it caches it here,
        // for a page that shows the main store without a core of its own and for a later Continue.
        const uiState = JSON.stringify(account);
        await store.writeUiCache(uiState);
        endRound({ session: { blob, uiState }, localWallet });
      },
      { pool: STEPS },
    );
  }

  /**
   * Asks the core to log in and handles its answer. A login that ends without a sign-in leaves a failure on show for
   * Retry, the core's own or one that says how it ended, so no dead code stays up. Never rejects.
   */
  async function runLogin(): Promise<void> {
    change({ pairing: SPINNER });
    try {
      const outcome = await commands.login();
      if (outcome.kind === 'paired') {
        await finishPairing(outcome.account).catch((error: unknown) => {
          reportStepFailure(error, 'finish');
          showFailed();
        });
        return;
      }
      if (screen.get().pairing.kind !== 'error') {
        change({ pairing: LOGIN_ENDED[outcome.kind] });
      }
    } catch (error) {
      reportStepFailure(error, 'pairing');
      showFailed();
    }
  }

  /**
   * Where the pairing on show stands while the window is open: failed while it shows how the pairing failed, otherwise
   * waiting on a login, and null off the pairing view. Every login's answer leaves the window no longer waiting, ended,
   * failed or showing how the pairing failed, so a sign-in the core picks up from elsewhere sends nothing by itself.
   */
  function getPairingOnShow(): 'waiting' | 'failed' | null {
    if (phase.kind !== 'open' || screen.get().view !== 'pairing') {
      return null;
    }
    if (screen.get().pairing.kind === 'error') {
      return 'failed';
    }
    return 'waiting';
  }

  /**
   * Shows the pairing and logs in, one login at a time. A pairing asked for while a login runs finds the window no
   * longer waiting once that login answered, so it joins it. Outside the steps, so Cancel or an import never waits on
   * it.
   */
  function pair(): void {
    show({ view: 'pairing' });
    void steps.call(
      async () => {
        if (getPairingOnShow() === 'waiting') {
          await runLogin();
        }
      },
      { pool: LOGINS },
    );
  }

  /**
   * Retry asks for a fresh login over a failure, so the failure gives way to the spinner first. A code a login under
   * way shows stays.
   */
  function clearPairingFailure(): void {
    if (screen.get().pairing.kind === 'error') {
      change({ pairing: SPINNER });
    }
  }

  /**
   * Offers what the store holds, else pairs. With nothing stored, a flag left set claims a sign-in that is gone, and
   * the keeper drops it only while the store is still empty, so a pairing under way that stores meanwhile keeps it.
   */
  async function offerOrPair(stored: SessionResult): Promise<void> {
    const offer = getContinueOffer(stored);
    if (offer !== null) {
      offered = stored;
      show({ view: 'continue', offer });
      return;
    }
    await signIns.clear();
    pair();
  }

  /** The rest of Use another account once the paired session ended: forget the wallet and pair. */
  async function leaveForAnother(): Promise<void> {
    tellAgain = null;
    // A store that cannot be read may still hold the session, so the window does not go on over it.
    const read = await store.readSession();
    if (read.status === 'failed' || read.blob !== null) {
      fail('sign-out');
      return;
    }
    try {
      await signIns.clear({
        drop: async () => {
          await wallet.forget();
          return true;
        },
      });
    } catch (error) {
      // The wallet is still stored, so the flag stays up for it.
      reportLocalWalletFailure(new Error('Local wallet could not be forgotten', { cause: error }), 'forget');
      await offerOrPair(await readStored());
      fail('sign-out');
      return;
    }
    pair();
  }

  /**
   * Sends what the store holds, with the flag landed first. A store with nothing to send, such as a flag left set over
   * an empty store, drops the flag and pairs.
   */
  async function sendStored(stored: SessionResult): Promise<void> {
    if (getContinueOffer(stored) === null) {
      await offerOrPair(stored);
      return;
    }
    // The flag lands before the page gets the result, since the page reads it as it takes the result.
    await signIns.store(() => {
      endRound(stored);
    });
  }

  /**
   * The first view once the opener is known, and Retry's after a step that failed. A page that knows a sign-in exists
   * elsewhere asked to take it, so the window sends it without offering Continue first.
   */
  async function decide(intent: SignInIntent): Promise<void> {
    switch (intent) {
      case 'phrase':
        // A module that could not load is a missed chunk, reported here once, so the step itself ends without failing.
        try {
          phraseCheck = await loadPhrase();
        } catch (error) {
          reportLazyMiss('wallet', 'phrase_import', error);
          showFailed();
          return;
        }
        show({ view: 'phrase' });
        return;
      case 'resume':
        log.event('sign-in window resumes the stored sign-in', { flow: 'wallet' });
        await sendStored(await readStored());
        return;
      case 'signin':
        await offerOrPair(await readStored());
        return;
    }
  }

  /**
   * Saves the wallet of `phrase` while the phrase view is on show and ends the round with it. Rejects when the phrase is
   * not valid or the wallet was not saved, each reported before it rejects. A session that cannot be read once the
   * wallet saved shows the failed view instead, since the form saying the save failed would be wrong.
   */
  async function savePhraseWallet(phrase: string): Promise<void> {
    const check = getPhraseOnShow();
    if (check === null) {
      return;
    }
    const entropy = check.toEntropy(phrase);
    if (entropy === null) {
      const error = new Error('Not a valid recovery phrase');
      reportStepFailure(error, 'phrase');
      throw error;
    }
    try {
      // Only a local wallet core reads the identity, and a window that takes a phrase pairs, so it saves none.
      await signIns.store(() => wallet.save(entropy, null));
    } catch (error) {
      const failure = new Error('The recovery phrase wallet could not be saved', { cause: error });
      reportLocalWalletFailure(failure, 'save');
      throw failure;
    }
    log.event('sign-in window saved a recovery phrase wallet', { flow: 'wallet' });
    // A paired session stays, so the user can switch back to it.
    let session: SessionResult['session'];
    try {
      session = await readSession();
    } catch (error) {
      const failure = new Error('The paired session could not be read after the wallet saved', { cause: error });
      reportStepFailure(failure, 'phrase');
      showFailed();
      return;
    }
    endRound({ session, localWallet: { entropy, identity: null } });
  }

  function handleResponderState(state: ResponderState): void {
    switch (state.kind) {
      case 'refused':
        show({ view: 'refused' });
        return;
      case 'answered':
        close();
        return;
      case 'connecting':
        return;
      case 'vetted':
        // Only the first vetting opens the phase. A window restored from the back-forward cache is vetted again with
        // its own request's round, which changes nothing.
        if (phase.kind !== 'waiting') {
          return;
        }
        phase = { kind: 'open', intent: requestIntent };
        change({ pageHost: pageLabel(state.origin) });
        break;
      case 'no-opener':
        phase = { kind: 'open', intent: getNoOpenerIntent(requestIntent) };
        break;
    }
    const { intent } = phase;
    void runStep({ name: 'decide', run: () => decide(intent), failure: 'view' });
  }
  // A flow lives as long as its window's page, and one whose phase ended only closes the window when the round ends, so
  // it keeps both listeners and has no dispose.
  responder.subscribe(handleResponderState);
  handleResponderState(responder.state());

  // Shown only: the login's answer, not the auth state, decides how a pairing ends.
  auth.subscribe(() => {
    change({ pairing: getPairingView(screen.get().pairing, auth.get()) });
  });

  const intents: WindowIntents = {
    continueWithStored: () =>
      runOnView({
        name: 'continue',
        view: 'continue',
        async run() {
          await sendStored(await readStoredForContinue());
        },
        failure: 'view',
      }),
    useAnotherAccount: () =>
      runOnView({
        name: 'another',
        view: 'continue',
        async run() {
          log.event('sign-in window uses another account', { flow: 'wallet' });
          // Tells the phone and clears the paired session. A failure is reported by the logout itself. The phone keeps
          // this browser listed until it is told, so the window goes on only once it was, or the user chooses to. Try
          // again on that failure tells the same session once more.
          const again = screen.get().failure === 'phone' ? tellAgain : null;
          const outcome = await (again === null ? commands.logout() : again());
          if (outcome.phone === 'untold') {
            fail('phone');
            tellAgain = outcome.tellAgain;
            return;
          }
          await leaveForAnother();
        },
        failure: 'step',
      }),
    goOnWithoutPhone: () =>
      runOnView({
        name: 'another',
        view: 'continue',
        async run() {
          if (screen.get().failure !== 'phone') {
            return;
          }
          log.event('sign-in window goes on with the phone not told', { flow: 'wallet' });
          await leaveForAnother();
        },
        failure: 'step',
      }),
    isValidPhrase: phrase => phraseCheck !== null && phraseCheck.toEntropy(phrase) !== null,
    // Outside `runStep`, since the form shows the failure from the rejection, which is reported before it rejects. Only
    // a phrase that is not valid or a wallet that was not saved rejects to the form.
    importPhrase: phrase => steps.call(() => savePhraseWallet(phrase), { pool: STEPS }),
    closePhrase: () =>
      runOnView({
        name: 'back',
        view: 'phrase',
        run: async () => offerOrPair(await readStored()),
        failure: 'view',
      }),
    async retry() {
      if (getPairingOnShow() === 'failed') {
        // A new login only once the one under way answered, so Retry never lands in the round of the failed one.
        await steps.settle(LOGINS);
        if (getPairingOnShow() === 'failed') {
          clearPairingFailure();
          pair();
        }
        return;
      }
      await runOnView({
        name: 'decide',
        view: 'failed',
        async run() {
          if (phase.kind === 'open') {
            // A login failure left from before cannot hold up the one decided, and a code a login under way shows
            // stays.
            clearPairingFailure();
            await decide(phase.intent);
          }
        },
        failure: 'view',
      });
    },
    // Outside the steps, so a wait for the core's write never holds the window open. A pairing given up stored
    // nothing and so raised no flag.
    cancel() {
      close();
    },
  };
  const shownScreen: ReadableStore<SignInScreen> = screen;

  return {
    /** What the window shows, which is always a view of a sign-in. */
    screen: shownScreen,
    /** Resolves once no step is queued or running. Never rejects. */
    settled: () => steps.settle(STEPS),
    ...intents,
  };
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

/**
 * The screen for `next`, which carries over what `shown` carries, each field as `change` gives it. A view takes only
 * its own fields from `next`, so an offer never outlives Continue.
 */
function getNextScreen({ shown, next, change }: GetNextScreenParams): SignInScreen {
  const carried: Carried = { pageHost: shown.pageHost, failure: shown.failure, pairing: shown.pairing, ...change };
  if (next.view === 'continue') {
    return { view: next.view, offer: next.offer, ...carried };
  }
  return { view: next.view, ...carried };
}

/** How far the core's pairing got. A disconnect leaves what is on show, so a failure stays up for Retry. */
function getPairingView(shown: PairingView, state: DotliAuthState): PairingView {
  switch (state.tag) {
    case 'Pairing':
      return state.deeplink ? { kind: 'pairing', payload: state.deeplink } : SPINNER;
    case 'Authenticating':
      return { kind: 'authenticating' };
    case 'LoginFailed':
      return getLoginFailureView(state.kind, state.reason);
    case 'Connected':
      return SPINNER;
    case 'Restoring':
    case 'Disconnected':
    case 'Unreachable':
      return shown;
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

function reportStepFailure(error: unknown, name: StepName): void {
  reportWalletFailure(error, {
    what: `session window ${name}`,
    step: STEPS,
    reason: name,
    metric: S.SESSION_WINDOW_FLOW,
  });
}
