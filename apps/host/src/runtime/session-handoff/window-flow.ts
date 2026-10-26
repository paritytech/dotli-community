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
import { createAsyncTaskPool, createSyncStore, log, shallowEqual, type ReadableStore } from '@dotli/shared';
import { reportLazyMiss } from '../../lazy-miss.js';
import type { PairingView } from '../../state/auth-modal.js';
import type {
  ContinueOffer,
  OfferedAccount,
  SignInScreen,
  WindowFailure,
  WindowIntents,
  WindowView,
} from '../../state/session-window.js';
import type { AuthCommands } from '../core-login.js';
import type { LogoutOutcome } from '../sign-out.js';
import { reportLocalWalletFailure, reportWalletFailure } from '../wallet-failure.js';
import { loginFailureView } from '../login-failure.js';
import type { DotliAuthState } from '../session/auth-state.js';
import type { HostCoreStorage } from '../session/core-storage.js';
import type { SignInFlag } from '../session/sign-in-flag.js';
import { localSessionUiState, parseUiStateCache, type TruapiSessionUiState } from '../session/ui-state.js';
import type { SessionResult, SignInIntent } from './messages.js';
import type { Responder, ResponderState } from './responder.js';

export type WindowFlow = {
  /** What the window shows, which is always a view of a sign-in. */
  screen: ReadableStore<SignInScreen>;
  /** Resolves once no step is queued or running. */
  settled(): Promise<void>;
} & WindowIntents;

/** The recovery phrase check the phrase view loads before it shows. */
export type PhraseCheck = {
  /** The phrase's entropy, or null for anything that is not a recovery phrase. */
  phraseToEntropy: (phrase: string) => Uint8Array | null;
};

export type WindowFlowDeps = {
  /** Watched only, so the flow learns where the round stands and never answers the opener itself. */
  responder: Pick<Responder<unknown>, 'state' | 'subscribe'>;
  /** The page's one flag keeper, so the flow's flag writes and the store writes stay in order. */
  signIns: SignInFlag;
  auth: ReadableStore<DotliAuthState>;
  commands: AuthCommands;
  store: Pick<HostCoreStorage, 'readSession' | 'readUiCache' | 'writeUiCache'>;
  wallet: {
    read: () => Promise<LocalWalletReadResult>;
    save: (entropy: Uint8Array, identity: LocalWalletIdentity | null) => Promise<void>;
    forget: () => Promise<void>;
  };
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
  close: () => void;
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

const STEPS = 'session_window';

/** The window's own logins, apart from the steps, since a login waits on the phone and must not hold up a step. */
const LOGINS = 'session_window_login';

const SPINNER: PairingView = { kind: 'spinner' };

/** What a login the core ended says, when the core said nothing of its own about it. */
const LOGIN_ENDED: Record<'failed' | 'cancelled', PairingView> = {
  failed: loginFailureView('Other', 'The sign-in did not complete'),
  cancelled: loginFailureView('Other', 'The sign-in was cancelled'),
};

/** What the window shows before its flow decides anything: it waits on its opener, or turned it away. */
export function responderScreen(state: ResponderState, pairing: PairingView = SPINNER): SignInScreen {
  return { view: state.kind === 'refused' ? 'refused' : 'connecting', pageHost: null, failure: null, pairing };
}

/** A view to show with what is its own, which only Continue has. */
type NextView = { view: 'continue'; offer: ContinueOffer } | { view: Exclude<SignInScreen['view'], 'continue'> };

/** What every sign-in view carries over to the next. */
type Carried = Pick<SignInScreen, 'pageHost' | 'failure' | 'pairing'>;

/**
 * The screen for `next`, which carries over what `shown` carries, each field as `change` gives it. A view takes only
 * its own fields from `next`, so an offer never outlives Continue.
 */
function nextScreen(shown: SignInScreen, next: NextView, change: Partial<Carried>): SignInScreen {
  const carried: Carried = { pageHost: shown.pageHost, failure: shown.failure, pairing: shown.pairing, ...change };
  return next.view === 'continue'
    ? { view: next.view, offer: next.offer, ...carried }
    : { view: next.view, ...carried };
}

/** How far the core's pairing got. A disconnect leaves what is on show, so a failure stays up for Retry. */
function pairingView(shown: PairingView, state: DotliAuthState): PairingView {
  switch (state.tag) {
    case 'Pairing':
      return state.deeplink ? { kind: 'pairing', payload: state.deeplink } : SPINNER;
    case 'Authenticating':
      return { kind: 'authenticating' };
    case 'LoginFailed':
      return loginFailureView(state.kind, state.reason);
    case 'Connected':
      return SPINNER;
    case 'Restoring':
    case 'Disconnected':
    case 'Unreachable':
      return shown;
  }
}

function accountOf(ui: TruapiSessionUiState | null): OfferedAccount | null {
  if (ui === null) {
    return null;
  }
  const { connected, ...account } = ui;
  return connected ? account : null;
}

function offerOf(stored: SessionResult): ContinueOffer | null {
  if (stored.localWallet !== null) {
    const identity = stored.localWallet.identity;
    return { wallet: 'local', account: identity === null ? null : accountOf(localSessionUiState(identity)) };
  }
  if (stored.session !== null) {
    const uiState = stored.session.uiState;
    return { wallet: 'paired', account: uiState === null ? null : accountOf(parseUiStateCache(uiState)) };
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

export function createWindowFlow(deps: WindowFlowDeps): WindowFlow {
  const { responder, signIns, auth, commands, store, wallet } = deps;
  const screen = createSyncStore<SignInScreen>(
    'sessionWindowFlow',
    responderScreen(responder.state(), pairingView(SPINNER, auth.get())),
    { equals: shallowEqual },
  );
  // One step at a time, so a second press waits for the first and finds the view it left.
  const steps = createAsyncTaskPool({ poolSize: 1 });
  let phase: Phase = { kind: 'waiting' };
  // What the Continue on show offers, as the store held it.
  let offered: SessionResult | null = null;
  // The retry of a sign-out the phone did not hear of, held only while that failure is on show.
  let tellAgain: (() => Promise<LogoutOutcome>) | null = null;
  // The phrase check, loaded before the phrase view shows. A debug-only feature, so no other view waits on it.
  let phraseCheck: PhraseCheck | null = null;

  const show = (next: NextView): void => {
    tellAgain = null;
    screen.set(nextScreen(screen.get(), next, { failure: null }));
  };

  /** Changes what the view on show carries, which keeps its own fields. */
  const change = (fields: Partial<Carried>): void => {
    const shown = screen.get();
    screen.set(nextScreen(shown, shown, fields));
  };

  const fail = (failure: WindowFailure): void => {
    tellAgain = null;
    change({ failure });
  };

  /** A step whose view cannot go on, so the window says so and offers Retry. */
  const showFailed = (): void => {
    if (phase.kind !== 'ended') {
      show({ view: 'failed' });
    }
  };

  /** Never rejects: a failure is reported, and shown as `failure` says. */
  const step = (name: StepName, run: () => Promise<void>, failure: StepFailure): Promise<void> =>
    steps.call(run, { pool: STEPS }).catch((error: unknown) => {
      reportStepFailure(error, name);
      if (failure === 'view') {
        showFailed();
      } else {
        fail('step');
      }
    });

  /** Whether a step the user asked for on `view` still applies, as the window may have left that view or ended. */
  const stillOn = (view: WindowView): boolean => phase.kind !== 'ended' && screen.get().view === view;

  /** The phrase view's check while that view is on show, which it never is before the check loaded. */
  const phraseOnShow = (): PhraseCheck | null => (stillOn('phrase') ? phraseCheck : null);

  /** A step the user asked for on `view`, which does nothing once the window left that view or ended. */
  const onView = (name: StepName, view: WindowView, run: () => Promise<void>, failure: StepFailure) =>
    step(
      name,
      async () => {
        if (stillOn(view)) {
          await run();
        }
      },
      failure,
    );

  /** The stored session blob. A store that cannot be read may still hold one, so the read fails the step. */
  const readBlob = async (): Promise<string | null> => {
    const read = await store.readSession();
    if (read.status === 'failed') {
      throw new Error('The main store could not be read', { cause: read.error });
    }
    return read.blob;
  };

  const readSession = async (): Promise<SessionResult['session']> => {
    const blob = await readBlob();
    return blob === null ? null : { blob, uiState: await store.readUiCache() };
  };

  /** A wallet that cannot be read is reported and taken as none, so the window still offers a session or pairs. */
  const readWallet = async (): Promise<SessionResult['localWallet']> => {
    try {
      const read = await wallet.read();
      return read.status === 'ok' ? { entropy: read.entropy, identity: read.identity } : null;
    } catch (error) {
      reportLocalWalletFailure(error, 'read');
      return null;
    }
  };

  /** What the main store holds, as the result carries it. */
  const readStored = async (): Promise<SessionResult> => {
    const [session, localWallet] = await Promise.all([readSession(), readWallet()]);
    return { session, localWallet };
  };

  /** Ends the round with what the store holds: handed to `deliver`, or said as done when no page opened the window. */
  const endRound = (result: SessionResult): void => {
    phase = { kind: 'ended' };
    if (responder.state().kind === 'no-opener') {
      log.event('sign-in window signed in with no opener', { flow: 'wallet' });
      show({ view: 'done-no-opener' });
      return;
    }
    log.event('sign-in window sends its result', { flow: 'wallet' });
    deps.deliver(result);
  };

  /** Sends what the login paired, which the command answered only once the main store held it. */
  const finishPairing = (account: TruapiSessionUiState): Promise<void> =>
    steps.call(
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

  /**
   * Asks the core to log in and handles its answer. A login that ends without a sign-in leaves a failure on show for
   * Retry, the core's own or one that says how it ended, so no dead code stays up. Never rejects.
   */
  const login = async (): Promise<void> => {
    change({ pairing: SPINNER });
    try {
      const outcome = await commands.login();
      if (outcome.kind === 'paired') {
        await finishPairing(outcome.account).catch((error: unknown) => {
          reportStepFailure(error, 'finish');
          showFailed();
        });
      } else if (screen.get().pairing.kind !== 'error') {
        change({ pairing: LOGIN_ENDED[outcome.kind] });
      }
    } catch (error) {
      reportStepFailure(error, 'pairing');
      showFailed();
    }
  };

  /**
   * Where the pairing on show stands while the window is open: failed while it shows how the pairing failed, otherwise
   * waiting on a login, and null off the pairing view. Every login's answer leaves the window no longer waiting, ended,
   * failed or showing how the pairing failed, so a sign-in the core picks up from elsewhere sends nothing by itself.
   */
  const pairingOnShow = (): 'waiting' | 'failed' | null => {
    if (phase.kind !== 'open' || screen.get().view !== 'pairing') {
      return null;
    }
    return screen.get().pairing.kind === 'error' ? 'failed' : 'waiting';
  };

  /**
   * Shows the pairing and logs in, one login at a time. A pairing asked for while a login runs finds the window no
   * longer waiting once that login answered, so it joins it. Outside the steps, so Cancel or an import never waits on
   * it.
   */
  const pair = (): void => {
    show({ view: 'pairing' });
    void steps.call(
      async () => {
        if (pairingOnShow() === 'waiting') {
          await login();
        }
      },
      { pool: LOGINS },
    );
  };

  /**
   * Retry asks for a fresh login over a failure, so the failure gives way to the spinner first. A code a login under
   * way shows stays.
   */
  const clearPairingFailure = (): void => {
    if (screen.get().pairing.kind === 'error') {
      change({ pairing: SPINNER });
    }
  };

  /**
   * Offers what the store holds, else pairs. With nothing stored, a flag left set claims a sign-in that is gone, and
   * the keeper drops it only while the store is still empty, so a pairing under way that stores meanwhile keeps it.
   */
  const offerOrPair = async (stored: SessionResult): Promise<void> => {
    const offer = offerOf(stored);
    if (offer !== null) {
      offered = stored;
      show({ view: 'continue', offer });
      return;
    }
    await signIns.clear();
    pair();
  };

  /** The rest of Use another account once the paired session ended: forget the wallet and pair. */
  const leaveForAnother = async (): Promise<void> => {
    tellAgain = null;
    // A store that cannot be read may still hold the session, so the window does not go on over it.
    const read = await store.readSession();
    if (read.status === 'failed' || read.blob !== null) {
      fail('sign-out');
      return;
    }
    try {
      await signIns.clear(async () => {
        await wallet.forget();
        return true;
      });
    } catch (error) {
      // The wallet is still stored, so the flag stays up for it.
      reportLocalWalletFailure(new Error('Local wallet could not be forgotten', { cause: error }), 'forget');
      await offerOrPair(await readStored());
      fail('sign-out');
      return;
    }
    pair();
  };

  /**
   * Sends what the store holds, with the flag landed first. A store with nothing to send, such as a flag left set over
   * an empty store, drops the flag and pairs.
   */
  const sendStored = async (stored: SessionResult): Promise<void> => {
    if (offerOf(stored) === null) {
      await offerOrPair(stored);
      return;
    }
    // The flag lands before the page gets the result, since the page reads it as it takes the result.
    await signIns.store(() => {
      endRound(stored);
    });
  };

  /**
   * The first view once the opener is known, and Retry's after a step that failed. A page that knows a sign-in exists
   * elsewhere asked to take it, so the window sends it without offering Continue first.
   */
  const decide = async (intent: SignInIntent): Promise<void> => {
    switch (intent) {
      case 'phrase':
        // A module that could not load is a missed chunk, reported here once, so the step itself ends without failing.
        try {
          phraseCheck = await deps.loadPhrase();
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
  };

  const onResponder = (state: ResponderState): void => {
    switch (state.kind) {
      case 'refused':
        show({ view: 'refused' });
        return;
      case 'answered':
        deps.close();
        return;
      case 'connecting':
        return;
      case 'vetted':
        // Only the first vetting opens the phase. A window restored from the back-forward cache is vetted again with
        // its own request's round, which changes nothing.
        if (phase.kind !== 'waiting') {
          return;
        }
        phase = { kind: 'open', intent: deps.intent };
        change({ pageHost: deps.pageLabel(state.origin) });
        break;
      case 'no-opener':
        phase = { kind: 'open', intent: deps.intent === 'phrase' ? 'phrase' : 'signin' };
        break;
    }
    const { intent } = phase;
    void step('decide', () => decide(intent), 'view');
  };
  responder.subscribe(onResponder);
  onResponder(responder.state());

  // Shown only: the login's answer, not the auth state, decides how a pairing ends.
  auth.subscribe(() => {
    change({ pairing: pairingView(screen.get().pairing, auth.get()) });
  });

  return {
    screen,
    settled: () => steps.settle(STEPS),
    continueWithStored: () =>
      onView(
        'continue',
        'continue',
        async () => {
          // A sign-out on another page clears the session and the wallet, so those are read again. The cached account
          // goes with the session it was read for.
          const [blob, localWallet] = await Promise.all([readBlob(), readWallet()]);
          const uiState =
            blob === null
              ? null
              : blob === offered?.session?.blob
                ? offered.session.uiState
                : await store.readUiCache();
          await sendStored({ session: blob === null ? null : { blob, uiState }, localWallet });
        },
        'view',
      ),
    useAnotherAccount: () =>
      onView(
        'another',
        'continue',
        async () => {
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
        'step',
      ),
    goOnWithoutPhone: () =>
      onView(
        'another',
        'continue',
        async () => {
          if (screen.get().failure !== 'phone') {
            return;
          }
          log.event('sign-in window goes on with the phone not told', { flow: 'wallet' });
          await leaveForAnother();
        },
        'step',
      ),
    isValidPhrase: phrase => phraseCheck !== null && phraseCheck.phraseToEntropy(phrase) !== null,
    // Outside `step`, since the form shows the failure from the rejection, which is reported before it rejects. Only
    // a phrase that is not valid or a wallet that was not saved rejects to the form.
    importPhrase: phrase =>
      steps.call(
        async () => {
          const check = phraseOnShow();
          if (check === null) {
            return;
          }
          const entropy = check.phraseToEntropy(phrase);
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
            // The wallet is stored by now, so the form saying the save failed would be wrong.
            showFailed();
            return;
          }
          endRound({ session, localWallet: { entropy, identity: null } });
        },
        { pool: STEPS },
      ),
    closePhrase: () => onView('back', 'phrase', async () => offerOrPair(await readStored()), 'view'),
    async retry() {
      if (pairingOnShow() === 'failed') {
        // A new login only once the one under way answered, so Retry never lands in the round of the failed one.
        await steps.settle(LOGINS);
        if (pairingOnShow() === 'failed') {
          clearPairingFailure();
          pair();
        }
        return;
      }
      await onView(
        'decide',
        'failed',
        async () => {
          if (phase.kind === 'open') {
            // A login failure left from before cannot hold up the one decided, and a code a login under way shows
            // stays.
            clearPairingFailure();
            await decide(phase.intent);
          }
        },
        'view',
      );
    },
    // Outside the steps, so a wait for the core's write never holds the window open. A pairing given up stored
    // nothing and so raised no flag.
    cancel() {
      deps.close();
    },
  };
}
