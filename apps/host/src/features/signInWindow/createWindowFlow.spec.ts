// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import type { LocalWalletIdentity, LocalWalletReadResult } from '@dotli/protocol';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { atom, type WritableAtom } from 'nanostores';
import { createDeferred, isRecord, waitForStatus } from '@dotli/shared';
import { catchError, must } from '@dotli/shared/testing';
import type { ContinueOffer, SignInScreen, WindowView } from './sessionWindowState.js';
import type { LoginOutcome, PairingView } from '../account/index.js';
import type { LogoutOutcome } from '../account/index.js';
import type { DotliAuthState } from '../account/index.js';
import { createFakeSessionPresence } from '../account/session/createPagePresence.fake.js';
import { createOwnerSignInFlag } from '../account/index.js';
import type { SignInIntent } from './parseWindowRequest.js';
import type { SessionResult } from './parseSessionResult.js';
import { createFakeMessageBus, createFakeWindowHandle } from './listenToMessages.fake.js';
import { createFakePageEvents } from '../../testing/pageEvents.js';
import { getOpenerParty } from '../../kit/openerRule.js';
import { createResponder } from './createResponder.js';
import { createWindowFlow, type PhraseCheck, type WindowFlow, type WindowFlowParams } from './createWindowFlow.js';
import { createHelloMessage } from '../../kit/sessionMessages.js';
import { getEndedLoginView } from './windowScreen.js';
import { getLoginFailureView } from '../account/index.js';

type Stored = {
  session?: string;
  uiState?: string;
  wallet?: { entropy: Uint8Array; identity: LocalWalletIdentity | null };
};

type OpenWindowParams = {
  /** The request's intent, `signin` by default. */
  intent?: SignInIntent;
  /** Whether a page opened the window, false for a window no page opened. */
  opener?: boolean;
  stored?: Stored;
  auth?: DotliAuthState;
  /** Runs with the window's auth state before the flow is built, so what it registers is heard before the flow. */
  beforeFlow?: (auth: WritableAtom<DotliAuthState>) => void;
  /** The phrase check's loader, by default one that has it at once. */
  loadPhrase?: WindowFlowParams['loadPhrase'];
  /** Whether what the flow delivers goes on to the opener, as the window's own delivery sends it. True by default. */
  forward?: boolean;
  /** How the views name the page that opened the window, by its host as for dot.li's own page by default. */
  page?: string;
  /** What the main store's session read fails with from the window's start, none by default. */
  readFailure?: Error;
  /** Runs on each flag write once the flag is up, and the write lands when it resolves. Lands at once by default. */
  onFlagSet?: () => Promise<void>;
};

type AnswerLoginParams = {
  /** How the login ended, paired by default. */
  outcome?: LoginOutcome;
};

const PAGE = 'https://browse.dot.li';
const BLOB = '0xsession';
const UI_STATE = JSON.stringify({ connected: true, publicKey: '0x01', liteUsername: 'alice.01' });
const ENTROPY = new Uint8Array(16).fill(7);
const PHRASE = 'twelve good words';
const PHRASE_ENTROPY = new Uint8Array(16).fill(9);
const IDENTITY: LocalWalletIdentity = { identityAccountId: '5Grwva', liteUsername: 'bob.02' };

/** A phrase check that knows only `PHRASE`. */
const PHRASE_CHECK: PhraseCheck = { toEntropy: phrase => (phrase === PHRASE ? PHRASE_ENTROPY : null) };

const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' };
const PAIRED_ACCOUNT = { connected: true, publicKey: '0x02', liteUsername: 'carol.03' };
const CONNECTED: DotliAuthState = { tag: 'Connected', session: PAIRED_ACCOUNT };
/** The command layer's answer once the core paired and stored the session. */
const PAIRED: LoginOutcome = { kind: 'paired', account: PAIRED_ACCOUNT };

const SELF = 'https://dot.li';

/**
 * A window flow over fakes: the opener, the flag, the window's auth state and core, and the main store, with the
 * window's real responder and flag keeper. The fake core stores and clears its session through that keeper.
 */
function openWindow(options: OpenWindowParams = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const opener = options.opener === false ? null : createFakeWindowHandle();
  const messages = createFakeMessageBus();
  const restores = createFakePageEvents();
  const responder = createResponder<SessionResult>({
    opener,
    judge: origin => getOpenerParty(origin, SELF),
    round: 'r1',
    listen: messages.listen,
    onPageRestore: restores.subscribe,
  });
  // A window builds its flow only once its opener was vetted, or when no page opened it.
  vet();
  const presence = createFakeSessionPresence({ state: 'present', onSet: options.onFlagSet });
  const auth = atom<DotliAuthState>(options.auth ?? { tag: 'Disconnected' });
  options.beforeFlow?.(auth);
  const main = { session: null, uiState: null, wallet: null, ...options.stored };
  const calls: string[] = [];
  // Each login the window asked for, which the test answers in place of the command layer.
  const logins: ReturnType<typeof createDeferred<LoginOutcome>>[] = [];
  const failures: {
    phone: boolean;
    save: Error | null;
    forget: Error | null;
    read: Error | null;
    walletRead: Error | null;
  } = {
    phone: false,
    save: null,
    forget: null,
    read: options.readFailure ?? null,
    walletRead: null,
  };
  const signIns = createOwnerSignInFlag({
    presence,
    readStoredSignIn: () => Promise.resolve(main.session !== null || main.wallet !== null ? 'held' : 'none'),
  });
  const commands: WindowFlowParams['commands'] = {
    login() {
      calls.push('login');
      const answer = createDeferred<LoginOutcome>();
      logins.push(answer);
      return answer.promise;
    },
  };
  const signOut: WindowFlowParams['signOut'] = {
    async signOut() {
      calls.push('logout');
      // Lets the paired session go from the store through the flag keeper whether or not the phone heard of it, and
      // answers whether it did.
      const held = main.session;
      if (held === null) {
        return { phone: 'told' };
      }
      await signIns.clear({
        drop() {
          main.session = null;
          main.uiState = null;
          return Promise.resolve(true);
        },
      });
      return getLogoutOutcome(held);
    },
    tellAgain(untold) {
      calls.push('tell again');
      return Promise.resolve(untold.reason === 'end' ? getLogoutOutcome(untold.blob) : untold);
    },
  };
  const closed = createDeferred<undefined>();
  // Each result the flow delivered, whether or not it went on to the opener.
  const delivered: SessionResult[] = [];
  const flow = createWindowFlow({
    responder,
    signIns,
    auth,
    commands,
    signOut,
    store: {
      readSession() {
        return Promise.resolve(
          failures.read === null ? { status: 'ok', blob: main.session } : { status: 'failed', error: failures.read },
        );
      },
      readUiCache() {
        return Promise.resolve(main.uiState);
      },
      writeUiCache(value) {
        main.uiState = value;
        return Promise.resolve();
      },
    },
    wallet: {
      read(): Promise<LocalWalletReadResult> {
        if (failures.walletRead !== null) {
          return Promise.reject(failures.walletRead);
        }
        return Promise.resolve(
          main.wallet === null ? { status: 'none' } : { status: 'ok', ...main.wallet, version: Uint8Array.of(1) },
        );
      },
      save(entropy, identity) {
        calls.push('save');
        if (failures.save !== null) {
          return Promise.reject(failures.save);
        }
        main.wallet = { entropy, identity };
        return Promise.resolve();
      },
      forget() {
        calls.push('forget');
        if (failures.forget !== null) {
          return Promise.reject(failures.forget);
        }
        main.wallet = null;
        return Promise.resolve();
      },
    },
    loadPhrase: options.loadPhrase ?? (() => Promise.resolve(PHRASE_CHECK)),
    intent: options.intent ?? 'signin',
    page: opener === null ? null : (options.page ?? new URL(PAGE).host),
    deliver(result) {
      delivered.push(result);
      if (options.forward !== false) {
        responder.send(result);
      }
    },
    close() {
      calls.push('close');
      closed.resolve(undefined);
    },
  });

  /** Whether the phone heard of `blob`'s sign-out, with what telling it again needs for a phone that missed it. */
  function getLogoutOutcome(blob: string): LogoutOutcome {
    return failures.phone ? { phone: 'untold', reason: 'end', blob } : { phone: 'told' };
  }

  /** The command layer answering the window's last login, paired by default. */
  function answerLogin({ outcome = PAIRED }: AnswerLoginParams = {}): void {
    logins.at(-1)?.resolve(outcome);
  }

  /** The command layer rejecting the window's last login, over a paired session it could not store. */
  function failLogin(error: Error): void {
    logins.at(-1)?.reject(error);
  }

  /** The page's hello for the request's round, which vets the opener. */
  function vet(): void {
    messages.post({ data: createHelloMessage('r1'), origin: PAGE, source: opener });
  }

  /** The window refusing its round to the vetted opener, as its caller does for a round it cannot serve. */
  function refuse(): void {
    responder.refuse('declined');
  }

  /** The results my opener got. */
  function readSent(): unknown[] {
    return (opener?.posted ?? []).flatMap(({ message }) =>
      isRecord(message) && message['type'] === 'dotli:s:result' ? [message['result']] : [],
    );
  }

  /** The core writing the session it paired through the window's flag keeper. */
  function storeSession(blob: string): Promise<void> {
    return signIns.store(() => {
      main.session = blob;
    });
  }

  return {
    flow,
    responder,
    presence,
    auth,
    main,
    calls,
    delivered,
    answerLogin,
    failLogin,
    failures,
    closed: closed.promise,
    metrics,
    vet,
    refuse,
    /** The window's page coming back from the back-forward cache. */
    restore: restores.fire,
    readSent,
    storeSession,
  };
}

/** What the view on show offers, null on a view other than Continue. */
function getOffer(flow: WindowFlow): ContinueOffer | null {
  const shown = flow.screen.get();
  return shown.view === 'continue' ? shown.offer : null;
}

/** Waits until the flow shows `view`. */
function waitForView(flow: WindowFlow, view: WindowView): Promise<SignInScreen> {
  return waitForStatus(flow.screen, current => current.view === view);
}

/** How far the pairing on show got, null on a view other than the pairing's. */
function getPairing(flow: WindowFlow): PairingView | null {
  const shown = flow.screen.get();
  return shown.view === 'pairing' ? shown.pairing : null;
}

/** Waits until the flow shows a pairing of `kind`. */
function waitForPairing(flow: WindowFlow, kind: PairingView['kind']): Promise<SignInScreen> {
  return waitForStatus(flow.screen, current => current.view === 'pairing' && current.pairing.kind === kind);
}

describe('session window flow', () => {
  it('As a user in a sign-in window whose round is refused, I see the refused view and no pairing starts', async () => {
    // Given a window over an empty main store, whose first read is under way
    const { flow, refuse, calls } = openWindow();

    // When the round is refused before that read answers
    refuse();
    await flow.await();

    // Then the refused view shows and no login started
    expect(flow.screen.get().view).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window with a stored session, I press Continue and the session is sent', async () => {
    // Given a window over a main store holding a paired session
    const { flow, readSent, presence, calls, closed } = openWindow({
      stored: { session: BLOB, uiState: UI_STATE },
    });

    // When the window's first step settles
    await waitForView(flow, 'continue');

    // Then Continue offers the paired account
    expect(getOffer(flow)).toEqual({
      wallet: 'paired',
      account: { publicKey: '0x01', liteUsername: 'alice.01' },
    });

    // When the flag is cleared elsewhere and the user presses Continue
    void presence.clear();
    await flow.continueWithStored();
    await closed;

    // Then the flag is set again and the window closes once it has sent what the store holds
    expect(presence.state).toBe('present');
    expect(readSent()).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
    expect(calls).toEqual(['close']);
  });

  it('As a user in the sign-in window with a stored session, I press Continue and the flow hands it to its delivery, which alone sends it', async () => {
    // Given a window on Continue whose delivery keeps what it gets
    const { flow, readSent, delivered, calls } = openWindow({
      stored: { session: BLOB, uiState: UI_STATE },
      forward: false,
    });
    await waitForView(flow, 'continue');

    // When the user presses Continue
    await flow.continueWithStored();

    // Then the flow delivered the stored session once, sent nothing itself and left the window open
    expect(delivered).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
    expect(readSent()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('As a dotli developer, I wire the window flow to its responder and the flow can only watch it, never send', () => {
    // Given the responder the flow depends on
    type FlowResponder = WindowFlowParams['responder'];

    // When its type is read
    const watched = expectTypeOf<FlowResponder>();

    // Then it has no subscription or send
    watched.not.toHaveProperty('subscribe');
    watched.not.toHaveProperty('send');
  });

  it('As a user in the sign-in window with a stored session and a local wallet, I am offered the local wallet and press Continue to send it', async () => {
    // Given a window over a main store holding a paired session and a local wallet
    const { flow, readSent, closed } = openWindow({
      stored: { session: BLOB, uiState: UI_STATE, wallet: { entropy: ENTROPY, identity: IDENTITY } },
    });

    // When the window's first step settles
    await waitForView(flow, 'continue');

    // Then Continue offers the local wallet's account
    expect(getOffer(flow)).toEqual({
      wallet: 'local',
      account: { identityAccountId: '5Grwva', liteUsername: 'bob.02', primaryUsername: 'bob.02' },
    });

    // When the user presses Continue
    await flow.continueWithStored();
    await closed;

    // Then the session and the wallet are sent together
    expect(readSent()).toEqual([
      { session: { blob: BLOB, uiState: UI_STATE }, localWallet: { entropy: ENTROPY, identity: IDENTITY } },
    ]);
  });

  it('As a user in the sign-in window with a wallet that has no identity, I am offered the local wallet with no account', async () => {
    // Given a window over a main store holding only a wallet with no identity
    const { flow } = openWindow({ stored: { wallet: { entropy: ENTROPY, identity: null } } });

    // When the window's first step settles
    await waitForView(flow, 'continue');

    // Then Continue offers the local wallet with no account
    expect(getOffer(flow)).toEqual({ wallet: 'local', account: null });
  });

  it('As a user in the sign-in window, I see the page named as the window is told to name it', async () => {
    // Given an empty main store and a window that names its page by its full origin
    const { flow } = openWindow({ page: PAGE });

    // When the window pairs
    await waitForView(flow, 'pairing');

    // Then the pairing names the page as told
    expect(flow.screen.get().pageHost).toBe(PAGE);
  });

  it('As a user in the sign-in window, I pair and the cookie is left to the core while the session it stored is sent', async () => {
    // Given a window over an empty main store
    const { flow, readSent, presence, auth, calls, closed, storeSession, answerLogin, main } = openWindow();

    // When the window's first step settles
    await waitForView(flow, 'pairing');

    // Then the flag claims no sign-in while nothing is stored and the window asks its core to pair
    expect(presence.state).toBe('absent');
    expect(calls).toEqual(['login']);

    // When the core pairs, stores the session it paired and reports it, and my login answers
    auth.set(PAIRING);
    await storeSession(BLOB);
    auth.set({ tag: 'Authenticating' });
    auth.set(CONNECTED);
    answerLogin();
    await closed;

    // Then the flow itself set nothing, since the core's own write raised the flag before and after the session landed
    expect(presence.calls).toEqual(['clear', 'set', 'set']);
    expect(readSent()).toEqual([
      { session: { blob: BLOB, uiState: JSON.stringify(PAIRED_ACCOUNT) }, localWallet: null },
    ]);
    // And the main store caches the paired account, so a page with no core and a later Continue show my name
    expect(main.uiState).toBe(JSON.stringify(PAIRED_ACCOUNT));
  });

  it('As a user in the sign-in window, I abandon pairing and the cookie stays unset', async () => {
    // Given a window pairing with its code on show
    const { flow, presence, auth, calls } = openWindow();
    await waitForView(flow, 'pairing');
    auth.set(PAIRING);

    // When the user presses Cancel
    flow.cancel();

    // Then the flag is cleared once and the window closes
    expect(presence.calls).toEqual(['clear']);
    expect(presence.state).toBe('absent');
    expect(calls).toEqual(['login', 'close']);
  });

  it('As a user in the sign-in window, I see my core report Connected and nothing is sent until my login answers', async () => {
    // Given a window whose core paired and stored the session
    const { flow, readSent, auth, closed, storeSession, answerLogin } = openWindow();
    await waitForView(flow, 'pairing');
    auth.set(PAIRING);
    await storeSession(BLOB);

    // When the core reports Connected
    auth.set(CONNECTED);
    await flow.await();

    // Then nothing went out on the report alone
    expect(readSent()).toEqual([]);

    // When the login answers
    answerLogin();
    await closed;

    // Then the paired session is sent once
    expect(readSent()).toEqual([
      { session: { blob: BLOB, uiState: JSON.stringify(PAIRED_ACCOUNT) }, localWallet: null },
    ]);
  });

  it('As a user in the sign-in window, I press Use another account and the phone is told, the store cleared and pairing started', async () => {
    // Given a window on Continue over a paired session and a local wallet
    const { flow, readSent, presence, auth, main, calls } = openWindow({
      stored: { session: BLOB, uiState: UI_STATE, wallet: { entropy: ENTROPY, identity: IDENTITY } },
      auth: CONNECTED,
    });
    await waitForView(flow, 'continue');

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the flow deletes the flag itself
    expect(calls).toEqual(['logout', 'forget', 'login']);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
    expect(presence.calls).toEqual(['clear']);
    expect(flow.screen.get().view).toBe('pairing');
    expect(readSent()).toEqual([]);

    // When the core starts pairing
    auth.set(PAIRING);

    // Then a pairing alone claims no sign-in
    expect(presence.state).toBe('absent');
  });

  it('As a user in the sign-in window whose sign-out could not tell the phone, I stay on Continue through a retry it missed and pair once a retry told it', async () => {
    // Given a window on Continue whose phone cannot be told
    const { flow, calls, failures, main } = openWindow({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: null } },
      auth: CONNECTED,
    });
    await waitForView(flow, 'continue');
    failures.phone = true;

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the store let the session go, but the window waits for the phone and keeps the wallet
    expect(flow.screen.get().view).toBe('continue');
    expect(flow.screen.get().failure).toBe('phone');
    expect(calls).toEqual(['logout']);
    expect(main.session).toBeNull();
    expect(main.wallet).not.toBeNull();

    // When the user tries again and the phone still misses it
    await flow.useAnotherAccount();

    // Then the phone was told again and the failure stays
    expect(calls).toEqual(['logout', 'tell again']);
    expect(flow.screen.get().failure).toBe('phone');

    // When the user tries again and the phone hears of the same session
    failures.phone = false;
    await flow.useAnotherAccount();

    // Then pairing starts with no failure once the phone was told
    expect(flow.screen.get().view).toBe('pairing');
    expect(flow.screen.get().failure).toBeNull();
    expect(calls).toEqual(['logout', 'tell again', 'tell again', 'forget', 'login']);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
  });

  it('As a user in the sign-in window whose sign-out could not tell the phone, I go on to another account without it and pairing starts', async () => {
    // Given a window on Continue whose phone could not be told
    const { flow, calls, failures, main } = openWindow({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: null } },
      auth: CONNECTED,
    });
    await waitForView(flow, 'continue');
    failures.phone = true;
    await flow.useAnotherAccount();

    // When the user goes on without the phone
    await flow.goOnWithoutPhone();

    // Then the store is emptied and pairing starts
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['logout', 'forget', 'login']);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
  });

  it('As a user in the sign-in window whose phone missed my sign-out, I go on over a main store that cannot be read and stay on Continue', async () => {
    // Given a window whose phone missed the sign-out over a store that cannot be read
    const { flow, calls, failures } = openWindow({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: null } },
      auth: CONNECTED,
    });
    await waitForView(flow, 'continue');
    failures.phone = true;
    await flow.useAnotherAccount();
    failures.read = new Error('frame down');

    // When the user goes on without the phone
    await flow.goOnWithoutPhone();

    // Then a session the store may still hold is not paired over
    expect(flow.screen.get().view).toBe('continue');
    expect(flow.screen.get().failure).toBe('sign-out');
    expect(calls).toEqual(['logout']);
  });

  it('As a user in the sign-in window on Continue with no sign-out failure on show, I press Go on and nothing happens', async () => {
    // Given a window on Continue with no failure on show
    const { flow, calls } = openWindow({ stored: { session: BLOB }, auth: CONNECTED });
    await waitForView(flow, 'continue');

    // When the user goes on without the phone
    await flow.goOnWithoutPhone();

    // Then the window stays on Continue and nothing ran
    expect(flow.screen.get().view).toBe('continue');
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window whose wallet could not be forgotten, I am offered it again and told so while the cookie stays', async () => {
    // Given a window on Continue whose wallet cannot be forgotten
    const { flow, presence, calls, failures, metrics } = openWindow({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: IDENTITY } },
      auth: CONNECTED,
    });
    await waitForView(flow, 'continue');
    failures.forget = new Error('frame down');

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the flag stays and Continue offers the wallet again with the failure
    expect(calls).toEqual(['logout', 'forget']);
    expect(presence.state).toBe('present');
    expect(flow.screen.get().view).toBe('continue');
    expect(getOffer(flow)).toEqual({
      wallet: 'local',
      account: { identityAccountId: '5Grwva', liteUsername: 'bob.02', primaryUsername: 'bob.02' },
    });
    expect(flow.screen.get().failure).toBe('sign-out');
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'forget' }]);
  });

  it('As a user who leaves an account whose wallet can be neither forgotten nor read, I see the window failed with no pairing, and Try again forgets the wallet again before it pairs', async () => {
    // Given a window on Continue whose wallet can be neither forgotten nor read
    const { flow, calls, failures } = openWindow({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: IDENTITY } },
      auth: CONNECTED,
    });
    await waitForView(flow, 'continue');
    failures.forget = new Error('frame down');
    failures.walletRead = new Error('frame down');

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the window fails and starts no pairing
    expect(calls).not.toContain('login');
    expect(flow.screen.get().view).toBe('failed');

    // When the user presses Try again while the wallet still cannot be forgotten
    await flow.retry();

    // Then the window tried the forget again, starts no pairing and stays failed
    expect(calls).toEqual(['logout', 'forget', 'forget']);
    expect(flow.screen.get().view).toBe('failed');

    // When the wallet can be forgotten and the user presses Try again
    failures.forget = null;
    await flow.retry();

    // Then the window forgets it and only then pairs
    expect(calls).toEqual(['logout', 'forget', 'forget', 'forget', 'login']);
    expect(flow.screen.get().view).toBe('pairing');
  });

  it('As a user in the sign-in window whose Continue failed, I see the failed view with Try again and the failure is reported', async () => {
    // Given a window on Continue over a store that cannot be read
    const { flow, readSent, failures, metrics } = openWindow({ stored: { session: BLOB } });
    await waitForView(flow, 'continue');
    failures.read = new Error('store down');

    // When the user presses Continue
    await flow.continueWithStored();

    // Then nothing is sent and the failed view shows, counted
    expect(readSent()).toEqual([]);
    expect(flow.screen.get().view).toBe('failed');
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'continue' }]);

    // When the store answers again and the user presses Try again
    failures.read = null;
    await flow.retry();

    // Then Continue is offered again
    expect(flow.screen.get().view).toBe('continue');
  });

  it('As a user in the sign-in window whose first step failed, I am told so instead of waiting and Retry decides again', async () => {
    // Given a store that cannot be read
    const stored: Stored = { session: BLOB };
    const readFailure = new Error('store down');

    // When the window opens over it and its first step settles
    const { flow, failures, metrics } = openWindow({ stored, readFailure });
    await flow.await();

    // Then the failed view shows, counted
    expect(flow.screen.get().view).toBe('failed');
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'decide' }]);

    // When the store answers again and the user presses Retry
    failures.read = null;
    await flow.retry();

    // Then Continue offers the stored session
    expect(flow.screen.get().view).toBe('continue');
    expect(getOffer(flow)).toEqual({ wallet: 'paired', account: null });
  });

  it('As a user in the sign-in window whose finish failed after pairing, I am told so and Retry offers the session it stored', async () => {
    // Given a window pairing over a store that cannot be read
    const { flow, auth, failures, storeSession, metrics, answerLogin } = openWindow();
    await waitForView(flow, 'pairing');
    auth.set(PAIRING);
    failures.read = new Error('store down');

    // When the core connects and the login answers
    auth.set(CONNECTED);
    answerLogin();
    await waitForView(flow, 'failed');

    // Then the finish failure is counted
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'finish' }]);

    // When the store recovers with the session and the user presses Retry
    failures.read = null;
    await storeSession(BLOB);
    await flow.retry();

    // Then Continue is offered
    expect(flow.screen.get().view).toBe('continue');
  });

  it('As a user in the sign-in window whose Back failed, I press Back and am told so with Retry', async () => {
    // Given a window on the phrase view over a store that cannot be read
    const { flow, failures } = openWindow({ intent: 'phrase' });
    await waitForView(flow, 'phrase');
    failures.read = new Error('store down');

    // When the user presses Back
    await flow.closePhrase();

    // Then the failed view shows
    expect(flow.screen.get().view).toBe('failed');

    // When the store recovers and the user presses Retry
    failures.read = null;
    await flow.retry();

    // Then the intent the opener named decides again
    expect(flow.screen.get().view).toBe('phrase');
  });

  it('As a user in the sign-in window, I press Retry on a view that did not fail and nothing happens', async () => {
    // Given a window pairing with nothing failed
    const { flow, calls } = openWindow();
    await waitForView(flow, 'pairing');

    // When the user presses Retry
    await flow.retry();

    // Then the window keeps pairing with its one login
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['login']);
  });

  it('As a user in the sign-in window, I import a phrase and it replaces the wallet, keeps the paired session and sends both', async () => {
    // Given a phrase window over a paired session and a local wallet
    const walletWhenSet: (Uint8Array | undefined)[] = [];
    const { flow, readSent, presence, main, calls, closed } = openWindow({
      intent: 'phrase',
      stored: { session: BLOB, uiState: UI_STATE, wallet: { entropy: ENTROPY, identity: IDENTITY } },
      onFlagSet() {
        walletWhenSet.push(main.wallet?.entropy);
        return Promise.resolve();
      },
    });
    await waitForView(flow, 'phrase');
    void presence.clear();

    // When the user imports a phrase
    await flow.importPhrase(PHRASE);
    await closed;

    // Then the flag was set before the new wallet was saved, and the new wallet replaced the old one
    expect(walletWhenSet[0]).toBe(ENTROPY);
    expect(presence.state).toBe('present');
    expect(calls).toEqual(['save', 'close']);
    expect(main.wallet).toEqual({ entropy: PHRASE_ENTROPY, identity: null });
    expect(main.session).toBe(BLOB);
    expect(readSent()).toEqual([
      { session: { blob: BLOB, uiState: UI_STATE }, localWallet: { entropy: PHRASE_ENTROPY, identity: null } },
    ]);
  });

  it('As a user in the sign-in window, I press Import twice while the first saves and the second press is ignored and resolves', async () => {
    // Given a phrase window
    const { flow, readSent, calls } = openWindow({ intent: 'phrase' });
    await waitForView(flow, 'phrase');

    // When the user imports a phrase twice at once
    const imports = Promise.all([flow.importPhrase(PHRASE), flow.importPhrase(PHRASE)]);

    // Then both presses resolve, the wallet is saved once and one result is sent
    await expect(imports).resolves.toEqual([undefined, undefined]);
    expect(calls).toEqual(['save', 'close']);
    expect(readSent()).toHaveLength(1);
  });

  it('As a user in the sign-in window whose wallet could not be saved, I see the form say so and the failure is reported and the cookie deleted', async () => {
    // Given a phrase window whose wallet save fails
    const { flow, readSent, presence, failures, metrics } = openWindow({ intent: 'phrase' });
    await waitForView(flow, 'phrase');
    failures.save = new Error('quota');

    // When the user imports a phrase
    const imported = flow.importPhrase(PHRASE);

    // Then the import rejects, nothing is sent, the flag goes back down and the failure is counted
    await expect(imported).rejects.toThrow('The recovery phrase wallet could not be saved');
    expect(readSent()).toEqual([]);
    expect(flow.screen.get().view).toBe('phrase');
    expect(presence.calls).toEqual(['set', 'clear']);
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'save' }]);
  });

  it('As a user in the sign-in window whose store cannot be read after my phrase wallet saved, I see the failed view and the form is not told the save failed', async () => {
    // Given a phrase window over a store that cannot be read, which nothing reads before the wallet saves
    const { flow, readSent, failures, metrics } = openWindow({ intent: 'phrase' });
    await waitForView(flow, 'phrase');
    failures.read = new Error('store down');

    // When the user imports a phrase
    await flow.importPhrase(PHRASE);

    // Then the import resolves on the failed view, nothing is sent and the failed read is counted
    expect(flow.screen.get().view).toBe('failed');
    expect(readSent()).toEqual([]);
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'phrase' }]);
  });

  it('As a user in the sign-in window, I enter a phrase that is not one and it is reported and touches nothing', async () => {
    // Given a phrase window
    const { flow, readSent, presence, calls, metrics } = openWindow({ intent: 'phrase' });
    await waitForView(flow, 'phrase');

    // When the user imports a phrase that is not one
    const imported = flow.importPhrase('not a phrase');

    // Then the import rejects, nothing is touched or sent and the failure is counted
    await expect(imported).rejects.toThrow('Not a valid recovery phrase');
    expect(calls).toEqual([]);
    expect(presence.calls).toEqual([]);
    expect(readSent()).toEqual([]);
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'phrase' }]);
  });

  it('As a debug panel user, I see no phrase form until the phrase check has loaded and then only a valid phrase is taken', async () => {
    // Given a phrase check still on its way
    const called = createDeferred<undefined>();
    const check = createDeferred<PhraseCheck>();

    // When a phrase window opens and asks for the check
    const { flow } = openWindow({
      intent: 'phrase',
      loadPhrase() {
        called.resolve(undefined);
        return check.promise;
      },
    });
    await called.promise;
    const takesPhraseBeforeLoad = flow.isValidPhrase(PHRASE);

    // Then the window still connects and takes no phrase
    expect(flow.screen.get().view).toBe('connecting');
    expect(takesPhraseBeforeLoad).toBe(false);

    // When the check loads
    check.resolve(PHRASE_CHECK);
    await waitForView(flow, 'phrase');
    const takes = { valid: flow.isValidPhrase(PHRASE), invalid: flow.isValidPhrase('not a phrase') };

    // Then the check takes only the valid phrase
    expect(takes).toEqual({ valid: true, invalid: false });
  });

  it('As a debug panel user whose phrase check failed to load, I see the failure and Retry loads it again', async () => {
    // Given a phrase check that fails to load once
    let loads = 0;
    const { flow, metrics } = openWindow({
      intent: 'phrase',
      loadPhrase() {
        loads += 1;
        return loads === 1 ? Promise.reject(new Error('chunk missing')) : Promise.resolve(PHRASE_CHECK);
      },
    });

    // When the first load fails
    await waitForView(flow, 'failed');
    const takesPhraseAfterMiss = flow.isValidPhrase(PHRASE);

    // Then the miss is counted once under the missed-chunk count, not the flow's
    expect(metrics.counted('lazy_chunk.load')).toEqual([{ outcome: 'error', reason: 'phrase_import' }]);
    expect(metrics.counted('session_window.flow')).toEqual([]);
    expect(takesPhraseAfterMiss).toBe(false);

    // When the user presses Retry
    await flow.retry();
    const takesPhraseAfterRetry = flow.isValidPhrase(PHRASE);

    // Then the check loads again and the phrase view shows
    expect(loads).toBe(2);
    expect(flow.screen.get().view).toBe('phrase');
    expect(takesPhraseAfterRetry).toBe(true);
  });

  it('As a user in the sign-in window opened for a phrase with nothing stored, I press Back and pairing starts', async () => {
    // Given a phrase window over an empty store
    const { flow, calls } = openWindow({ intent: 'phrase' });
    await waitForView(flow, 'phrase');

    // When the user presses Back
    await flow.closePhrase();

    // Then pairing starts
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['login']);
  });

  it('As a user in a sign-in window with no opener, I sign in against the main store and nothing is sent, which the window says', async () => {
    // Given a window with no opener, pairing
    const { flow, delivered, auth, storeSession, answerLogin } = openWindow({ opener: false });
    await waitForView(flow, 'pairing');

    // When the core pairs and stores the session and the login answers
    auth.set(PAIRING);
    await storeSession(BLOB);
    auth.set(CONNECTED);
    answerLogin();
    await waitForView(flow, 'done-no-opener');

    // Then nothing is delivered and no page is named
    expect(flow.screen.get().pageHost).toBeNull();
    expect(delivered).toEqual([]);
  });

  it('As a user in a sign-in window with no opener whose request asks for a phrase, I open it and see the phrase view first', async () => {
    // Given a window with no opener whose request asks for a phrase
    const { flow, calls } = openWindow({ opener: false, intent: 'phrase' });

    // When the flow settles
    await flow.await();

    // Then the phrase view shows and no login starts
    expect(flow.screen.get().view).toBe('phrase');
    expect(calls).toEqual([]);
  });

  it('As a user who opens a resume window with no opener, I wait for nobody and am offered what is stored, as a sign-in window offers it', async () => {
    // Given a window with no opener whose request asks to resume, over a stored session
    const { flow } = openWindow({
      opener: false,
      intent: 'resume',
      stored: { session: BLOB, uiState: UI_STATE },
    });

    // When the flow settles
    await flow.await();

    // Then Continue offers the stored account
    expect(flow.screen.get().view).toBe('continue');
    expect(getOffer(flow)).toEqual({
      wallet: 'paired',
      account: { publicKey: '0x01', liteUsername: 'alice.01' },
    });
  });

  it('As a user in the sign-in window whose store was emptied before Continue, I press Continue and pair instead of sending nothing', async () => {
    // Given a window on Continue whose store was emptied since
    const { flow, readSent, main, calls } = openWindow({ stored: { session: BLOB } });
    await waitForView(flow, 'continue');
    main.session = null;

    // When the user presses Continue
    await flow.continueWithStored();

    // Then pairing starts and nothing is sent
    expect(flow.screen.get().view).toBe('pairing');
    expect(readSent()).toEqual([]);
    expect(calls).toEqual(['login']);
  });

  it('As a user pairing in a restored sign-in window whose store cannot be read, I return to it and my code stays with nothing decided again', async () => {
    // Given a window pairing with its code on show, restored while its read of the store fails
    const { flow, vet, restore, auth, calls, failures, metrics } = openWindow();
    await waitForView(flow, 'pairing');
    auth.set(PAIRING);
    failures.read = new Error('frame down');
    restore();

    // When its opener vets the request's round again
    vet();
    await flow.await();

    // Then the login under way still shows its code, no step read the store and no second login started
    expect(flow.screen.get().view).toBe('pairing');
    expect(getPairing(flow)).toEqual({ kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' });
    expect(metrics.counted('session_window.flow')).toEqual([]);
    expect(calls).toEqual(['login']);
  });

  it('As a user in the sign-in window on a flag store that answers late, I press Continue and the session is sent only once the flag landed', async () => {
    // Given a window on Continue whose flag write is held
    const landed = createDeferred<undefined>();
    const asked = createDeferred<undefined>();
    const { flow, readSent } = openWindow({
      stored: { session: BLOB },
      onFlagSet() {
        asked.resolve(undefined);
        return landed.promise;
      },
    });
    await waitForView(flow, 'continue');

    // When the user presses Continue and the flag write is asked
    const continued = flow.continueWithStored();
    await asked.promise;

    // Then nothing is sent yet
    expect(readSent()).toEqual([]);

    // When the flag write lands
    landed.resolve(undefined);
    await continued;

    // Then the session is sent
    expect(readSent()).toHaveLength(1);
  });

  it('As a user in the sign-in window, I press Continue twice and the second press sends nothing more', async () => {
    // Given a window on Continue over a stored session
    const { flow, readSent, calls } = openWindow({ stored: { session: BLOB } });
    await waitForView(flow, 'continue');

    // When the user presses Continue twice at once
    await Promise.all([flow.continueWithStored(), flow.continueWithStored()]);

    // Then one result is sent and the window closes once
    expect(readSent()).toHaveLength(1);
    expect(calls).toEqual(['close']);
  });

  it('As a user in the sign-in window, I see how far my pairing got and its failure stays through a disconnect while Retry pairs again', async () => {
    // Given a window pairing
    const { flow, auth, calls, answerLogin } = openWindow();
    await waitForView(flow, 'pairing');

    // When the core shows its code, then fails, then reads signed out
    auth.set(PAIRING);
    const shownCode = getPairing(flow);
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'Login request denied' });
    auth.set({ tag: 'Disconnected' });

    // Then the code showed and the declined failure stays with Retry
    expect(shownCode).toEqual({ kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' });
    expect(getPairing(flow)).toEqual(getLoginFailureView('Other', 'Login request denied'));

    // When Retry is pressed before my login answered, and it answers that it failed
    const retried = flow.retry();
    answerLogin({ outcome: { kind: 'failed' } });
    await retried;
    await waitForPairing(flow, 'spinner');
    await flow.await();

    // Then a new login started only once the failed one answered, and the failure gave way to a fresh pairing
    expect(getPairing(flow)).toEqual({ kind: 'spinner' });
    expect(calls).toEqual(['login', 'login']);
  });

  it('As a user in the sign-in window whose core cancelled my login after showing its code, I am told the sign-in was cancelled and Retry pairs again', async () => {
    // Given a pairing whose code is on show
    const { flow, auth, calls, answerLogin } = openWindow();
    await waitForView(flow, 'pairing');
    auth.set(PAIRING);

    // When the core ends the login with no failure of its own, and reads signed out
    answerLogin({ outcome: { kind: 'cancelled' } });
    auth.set({ tag: 'Disconnected' });
    await waitForPairing(flow, 'error');

    // Then the dead code is gone and Retry is offered
    expect(getPairing(flow)).toEqual(getEndedLoginView('cancelled'));

    // When the user presses Retry
    await flow.retry();

    // Then a new login starts with the spinner
    expect(getPairing(flow)).toEqual({ kind: 'spinner' });
    expect(calls).toEqual(['login', 'login']);
  });

  it('As a user in the sign-in window whose pairing failed, I sign in on another tab and the failure stays while Retry offers that sign-in', async () => {
    // Given a pairing whose login answered that it failed
    const { flow, auth, main, calls, answerLogin } = openWindow();
    await waitForView(flow, 'pairing');
    answerLogin({ outcome: { kind: 'failed' } });
    await waitForPairing(flow, 'error');

    // When a sign-in made on another tab is stored and the window's core reports it
    main.session = BLOB;
    main.uiState = UI_STATE;
    auth.set(CONNECTED);

    // Then the failure stays with Retry
    expect(getPairing(flow)).toMatchObject({ kind: 'error', retry: true });

    // When the user presses Retry
    await flow.retry();

    // Then the stored sign-in is offered, and no second login started
    expect(flow.screen.get().view).toBe('continue');
    expect(getOffer(flow)).toEqual({ wallet: 'paired', account: { publicKey: '0x01', liteUsername: 'alice.01' } });
    expect(calls).toEqual(['login']);
  });

  it('As a user in the sign-in window whose pairing failed, I press Retry while the store cannot be read and see the failed view with no second login', async () => {
    // Given a pairing whose login answered that it failed
    const { flow, calls, failures, answerLogin } = openWindow();
    await waitForView(flow, 'pairing');
    answerLogin({ outcome: { kind: 'failed' } });
    await waitForPairing(flow, 'error');

    // When the main store cannot be read and the user presses Retry
    failures.read = new Error('store down');
    await flow.retry();

    // Then the failed view shows and no second login started
    expect(flow.screen.get().view).toBe('failed');
    expect(calls).toEqual(['login']);
  });

  it("As a dotli integrator, I dispose a flow while its login runs and it shows nothing of the core's pairing after it", async () => {
    // Given a window whose login runs
    const { flow, auth } = openWindow();
    await waitForView(flow, 'pairing');
    const shown = flow.screen.get();

    // When it is disposed and the core then shows its code
    flow.dispose();
    auth.set(PAIRING);

    // Then the flow shows what it showed
    expect(flow.screen.get()).toBe(shown);
  });

  it('As a user in the sign-in window whose login failed with no word from the core, I am told so and the code goes', async () => {
    // Given a pairing whose code is on show
    const { flow, auth, answerLogin } = openWindow();
    await waitForView(flow, 'pairing');
    auth.set(PAIRING);

    // When the login answers failed
    answerLogin({ outcome: { kind: 'failed' } });
    await waitForPairing(flow, 'error');

    // Then the generic failure shows with Retry
    expect(getPairing(flow)).toEqual(getEndedLoginView('failed'));
  });

  it('As a user in the sign-in window whose pairing could not be stored, I am told so and Retry pairs again', async () => {
    // Given a window pairing
    const { flow, calls, metrics, failLogin } = openWindow();
    await waitForView(flow, 'pairing');

    // When the command layer says the paired session could not be stored
    failLogin(new Error('The paired session could not be stored'));
    await waitForView(flow, 'failed');

    // Then the pairing failure is counted
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'pairing' }]);

    // When the user presses Retry
    await flow.retry();

    // Then nothing is stored, so the window pairs again
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['login', 'login']);
  });

  it('As a user in the sign-in window whose pairing could not be stored, I hear my core report a pairing after it and the failed view stays', async () => {
    // Given a window whose pairing could not be stored
    const { flow, auth, failLogin } = openWindow();
    await waitForView(flow, 'pairing');
    failLogin(new Error('The paired session could not be stored'));
    await waitForView(flow, 'failed');
    const shown = flow.screen.get();

    // When the core reports a pairing
    auth.set(PAIRING);
    await flow.await();

    // Then the failed view stays
    expect(flow.screen.get()).toBe(shown);
  });

  it('As a user in the sign-in window on Continue, I see my core pick up a sign-in from elsewhere and nothing is sent by itself', async () => {
    // Given no login of mine runs
    const { flow, auth, readSent, calls } = openWindow({ stored: { session: BLOB } });
    await waitForView(flow, 'continue');

    // When the core reports Connected
    auth.set(CONNECTED);
    await flow.await();

    // Then the user still chooses
    expect(flow.screen.get().view).toBe('continue');
    expect(readSent()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window whose store took another sign-in before Continue, I press Continue and that one is sent with its own account', async () => {
    // Given a window on Continue whose store took another session since
    const { flow, main, readSent, closed } = openWindow({ stored: { session: BLOB, uiState: UI_STATE } });
    await waitForView(flow, 'continue');
    const otherAccount = JSON.stringify(PAIRED_ACCOUNT);
    main.session = '0xother';
    main.uiState = otherAccount;

    // When the user presses Continue
    await flow.continueWithStored();
    await closed;

    // Then the new session is sent with its own account
    expect(readSent()).toEqual([{ session: { blob: '0xother', uiState: otherAccount }, localWallet: null }]);
  });

  it('As a user in the sign-in window whose stored wallet was signed out elsewhere before Continue, I press Continue and pair instead', async () => {
    // Given a window on Continue whose stored wallet was forgotten since
    const { flow, main, readSent, calls } = openWindow({
      stored: { wallet: { entropy: ENTROPY, identity: null } },
    });
    await waitForView(flow, 'continue');
    main.wallet = null;

    // When the user presses Continue
    await flow.continueWithStored();

    // Then pairing starts and nothing is sent
    expect(flow.screen.get().view).toBe('pairing');
    expect(readSent()).toEqual([]);
    expect(calls).toEqual(['login']);
  });

  describe('resuming a sign-in made elsewhere', () => {
    it('As a user in a sign-in window a page asked to resume, I am not offered Continue and the stored session is sent at once after the flag landed', async () => {
      // Given a window over a stored session with its views and flag writes recorded
      const order: string[] = [];
      const { flow, readSent, presence, calls, closed } = openWindow({
        intent: 'resume',
        stored: { session: BLOB, uiState: UI_STATE },
        onFlagSet() {
          order.push(`flag with ${String(readSent().length)} sent`);
          return Promise.resolve();
        },
      });
      const views: WindowView[] = [];
      onTestFinished(
        flow.screen.listen(() => {
          views.push(flow.screen.get().view);
        }),
      );

      // When the window's first steps settle and it closes
      await closed;

      // Then the session is sent after the flag, with no Continue on show
      expect(readSent()).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
      expect(order[0]).toBe('flag with 0 sent');
      expect(presence.state).toBe('present');
      expect(views).not.toContain('continue');
      expect(calls).toEqual(['close']);
    });

    it('As a user in a sign-in window asked to resume over an empty store, I fall back to signing in and the stale flag is dropped', async () => {
      // Given a window over an empty store
      const { flow, readSent, presence, calls } = openWindow({ intent: 'resume' });

      // When the window's first steps settle on the pairing
      await waitForView(flow, 'pairing');

      // Then nothing is sent, the flag drops and pairing starts
      expect(readSent()).toEqual([]);
      expect(presence.state).toBe('absent');
      expect(calls).toEqual(['login']);
    });

    it('As a user in a sign-in window whose resume failed, I am told so and Retry sends the stored sign-in', async () => {
      // Given a resume that failed on a store that could not be read
      const { flow, readSent, failures, closed } = openWindow({
        intent: 'resume',
        stored: { session: BLOB, uiState: UI_STATE },
        readFailure: new Error('frame unavailable'),
      });
      await waitForView(flow, 'failed');

      // When the store recovers and the user presses Retry
      failures.read = null;
      await flow.retry();
      await closed;

      // Then the stored session is sent
      expect(readSent()).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
    });
  });

  it("As a dotli integrator, I dispose a flow while a step reads the store and the step's answer changes nothing", async () => {
    // Given a window on Continue whose Continue reads the store
    const { flow, delivered } = openWindow({ stored: { session: BLOB, uiState: UI_STATE } });
    await waitForView(flow, 'continue');
    const continued = flow.continueWithStored();
    const shown = flow.screen.get();

    // When it is disposed before the read answers
    flow.dispose();
    await continued;

    // Then the read's answer delivered nothing and the screen stayed
    expect(delivered).toEqual([]);
    expect(flow.screen.get()).toBe(shown);
  });

  it('As a dotli integrator, I dispose a flow that delivered and it closes nothing when its responder answers after it', async () => {
    // Given a flow that sent the stored session to its opener and is held on, with the result not passed on yet
    const { flow, responder, calls, delivered } = openWindow({
      stored: { session: BLOB, uiState: UI_STATE },
      forward: false,
    });
    await waitForView(flow, 'continue');
    await flow.continueWithStored();

    // When it is disposed and its responder then answers the opener
    flow.dispose();
    responder.send(must(delivered[0], 'a delivered result'));

    // Then the window was not closed by the flow
    expect(responder.state.get()).toEqual({ kind: 'answered' });
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window, I hear my core move past its code while my login runs and see the step it moved on to', async () => {
    // Given a listener, registered before the flow, that moves auth on from Pairing to Authenticating
    const { flow, auth } = openWindow({
      beforeFlow(source) {
        onTestFinished(
          source.listen(state => {
            if (state.tag === 'Pairing') {
              source.set({ tag: 'Authenticating' });
            }
          }),
        );
      },
    });
    // And a login under way, which starts in the same turn as the pairing view
    await waitForView(flow, 'pairing');
    const seen: PairingView[] = [];
    onTestFinished(
      flow.screen.subscribe(screen => {
        if (screen.view === 'pairing') {
          seen.push(screen.pairing);
        }
      }),
    );

    // When the core starts pairing
    auth.set(PAIRING);

    // Then the screen shows the step the core moved on to
    expect(getPairing(flow)).toEqual({ kind: 'authenticating' });
    // And no screen in between showed the code the core moved past
    expect(seen.some(pairing => pairing.kind === 'pairing')).toBe(false);
  });

  it('As a dotli integrator, I dispose a flow twice and see no error', () => {
    // Given a flow disposed once
    const { flow } = openWindow();
    flow.dispose();

    // When it is disposed again
    const thrown = catchError(() => {
      flow.dispose();
    });

    // Then nothing threw
    expect(thrown).toBeUndefined();
  });
});
