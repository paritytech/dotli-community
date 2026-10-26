// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import type { LocalWalletIdentity, LocalWalletReadResult } from '@dotli/protocol';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createSyncStore, deferred, untilStatus } from '@dotli/shared';
import { recordLog } from '@dotli/shared/testing';
import type { ContinueOffer, SignInScreen, WindowView } from '../../state/session-window.js';
import type { AuthCommands, LoginOutcome } from '../core-login.js';
import type { LogoutOutcome } from '../sign-out.js';
import type { DotliAuthState } from '../session/auth-state.js';
import { createFakeSessionPresence } from '../session/presence.fake.js';
import { ownerSignInFlag } from '../session/sign-in-flag.js';
import type { SessionResult, SignInIntent } from './messages.js';
import { createFakeMessageBus, createFakeWindowHandle } from './messages.fake.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import { createResponder } from './responder.js';
import { createWindowFlow, type PhraseCheck, type WindowFlow, type WindowFlowDeps } from './window-flow.js';

const PAGE = 'https://browse.dot.li';
const BLOB = '0xsession';
const UI_STATE = JSON.stringify({ connected: true, publicKey: '0x01', liteUsername: 'alice.01' });
const ENTROPY = new Uint8Array(16).fill(7);
const PHRASE = 'twelve good words';
const PHRASE_ENTROPY = new Uint8Array(16).fill(9);
const IDENTITY: LocalWalletIdentity = { identityAccountId: '5Grwva', liteUsername: 'bob.02' };

/** A phrase check that knows only `PHRASE`. */
const PHRASE_CHECK: PhraseCheck = { phraseToEntropy: phrase => (phrase === PHRASE ? PHRASE_ENTROPY : null) };

const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' };
const PAIRED_ACCOUNT = { connected: true, publicKey: '0x02', liteUsername: 'carol.03' };
const CONNECTED: DotliAuthState = { tag: 'Connected', session: PAIRED_ACCOUNT };
/** The command layer's answer once the core paired and stored the session. */
const PAIRED: LoginOutcome = { kind: 'paired', account: PAIRED_ACCOUNT };

const SELF = 'https://dot.li';

interface Stored {
  session?: string;
  uiState?: string;
  wallet?: { entropy: Uint8Array; identity: LocalWalletIdentity | null };
}

interface HarnessOptions {
  /** The intent the opener's hello names before the flow starts. Without it the window still waits for one. */
  vetted?: SignInIntent;
  /** Whether a page opened the window, false for a window no page opened. */
  opener?: boolean;
  stored?: Stored;
  auth?: DotliAuthState;
  urlIntent?: SignInIntent;
  /** The phrase check's loader, by default one that has it at once. */
  loadPhrase?: WindowFlowDeps['loadPhrase'];
}

/**
 * A window flow over fakes: the opener, the flag, the window's auth state and core, and the main store, with the
 * window's real responder and flag keeper. The fake core stores and clears its session through that keeper.
 */
function harness(options: HarnessOptions = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const opener = options.opener === false ? null : createFakeWindowHandle();
  const messages = createFakeMessageBus();
  const restores = createFakePageEvents();
  const responder = createResponder({
    opener,
    self: SELF,
    listen: messages.listen,
    onPageRestore: restores.subscribe,
  });
  /** The opener's hello for `round`, from a page or, refused, from a product. */
  const hello = (intent: SignInIntent, origin = PAGE, round = 'r1'): void => {
    messages.post({ data: { type: 'dotli:session:hello', round, intent }, origin, source: opener });
  };
  if (options.vetted !== undefined) {
    hello(options.vetted);
  }
  const presence = createFakeSessionPresence('present');
  const auth = createSyncStore<DotliAuthState>('testAuth', options.auth ?? { tag: 'Disconnected' }, {
    equals: () => false,
  });
  const main = {
    session: options.stored?.session ?? null,
    uiState: options.stored?.uiState ?? null,
    wallet: options.stored?.wallet ?? null,
  };
  const calls: string[] = [];
  const reads = { uiCache: 0 };
  // Each login the window asked for, which the test answers in place of the command layer.
  const logins: ReturnType<typeof deferred<LoginOutcome>>[] = [];
  const failures: { phone: boolean; save: Error | null; forget: Error | null; read: Error | null } = {
    phone: false,
    save: null,
    forget: null,
    read: null,
  };
  const signIns = ownerSignInFlag({
    presence,
    storedSignIn: () => Promise.resolve(main.session !== null || main.wallet !== null ? 'held' : 'none'),
  });
  const commands: AuthCommands = {
    login: () => {
      calls.push('login');
      const answer = deferred<LoginOutcome>();
      logins.push(answer);
      return answer.promise;
    },
    logout: async () => {
      calls.push('logout');
      // Lets the paired session go from the store through the flag keeper whether or not the phone heard of it, and
      // answers whether it did, with one more try for a phone that missed it.
      const held = main.session;
      if (held === null) {
        return { phone: 'told' };
      }
      await signIns.clear(() => {
        main.session = null;
        main.uiState = null;
        return Promise.resolve(true);
      });
      const told = (): LogoutOutcome =>
        failures.phone
          ? {
              phone: 'untold',
              tellAgain: () => {
                calls.push('tell again');
                return Promise.resolve(told());
              },
            }
          : { phone: 'told' };
      return told();
    },
    cancelLogin: () => {
      calls.push('cancelLogin');
    },
  };
  const closed = deferred<undefined>();
  const flow = createWindowFlow({
    responder,
    signIns,
    auth,
    commands,
    store: {
      readSession: () =>
        Promise.resolve(
          failures.read === null ? { status: 'ok', blob: main.session } : { status: 'failed', error: failures.read },
        ),
      readUiCache: () => {
        reads.uiCache += 1;
        return Promise.resolve(main.uiState);
      },
      writeUiCache: value => {
        main.uiState = value;
        return Promise.resolve();
      },
    },
    wallet: {
      read: (): Promise<LocalWalletReadResult> =>
        Promise.resolve(
          main.wallet === null ? { status: 'none' } : { status: 'ok', ...main.wallet, version: Uint8Array.of(1) },
        ),
      save: (entropy, identity) => {
        calls.push('save');
        if (failures.save !== null) {
          return Promise.reject(failures.save);
        }
        main.wallet = { entropy, identity };
        return Promise.resolve();
      },
      forget: () => {
        calls.push('forget');
        if (failures.forget !== null) {
          return Promise.reject(failures.forget);
        }
        main.wallet = null;
        return Promise.resolve();
      },
    },
    loadPhrase: options.loadPhrase ?? (() => Promise.resolve(PHRASE_CHECK)),
    urlIntent: options.urlIntent ?? 'signin',
    close: () => {
      calls.push('close');
      closed.resolve(undefined);
    },
  });
  return {
    flow,
    presence,
    auth,
    main,
    calls,
    reads,
    /** The command layer answering the window's last login, paired by default. */
    answerLogin: (outcome: LoginOutcome = PAIRED) => {
      logins.at(-1)?.resolve(outcome);
    },
    /** The command layer rejecting the window's last login, over a paired session it could not store. */
    failLogin: (error: Error) => {
      logins.at(-1)?.reject(error);
    },
    failures,
    closed: closed.promise,
    metrics,
    errors,
    /** The opener vetted for round `r1`. */
    vet: (intent: SignInIntent = 'signin') => {
      hello(intent);
    },
    /** The opener vetted for another round, which a window restored after its opener started a new one sees. */
    vetRound: (round: string) => {
      hello('signin', PAGE, round);
    },
    /** A product's page saying hello, which the window refuses. */
    refuse: () => {
      hello('signin', 'https://x.app.dot.li');
    },
    /** The window's page coming back from the back-forward cache. */
    restore: restores.fire,
    /** The results my opener got. */
    sent: () =>
      (opener?.posted ?? []).flatMap(({ message }) =>
        (message as { type: string }).type === 'dotli:session:result'
          ? [(message as { result: SessionResult }).result]
          : [],
      ),
    /** The core writing the session it paired through the window's flag keeper. */
    storeSession: (blob: string) =>
      signIns.store(() => {
        main.session = blob;
      }),
  };
}

/** Waits until the flow shows `view`. */
function untilScreen(flow: WindowFlow, met: (screen: SignInScreen) => boolean): Promise<void> {
  return untilStatus(
    {
      get: flow.screen.get,
      subscribe: listener =>
        flow.screen.subscribe(() => {
          listener(flow.screen.get());
        }),
    },
    met,
  );
}

/** What the view on show offers, null on a view other than Continue. */
function offerOn(flow: WindowFlow): ContinueOffer | null {
  const shown = flow.screen.get();
  return shown.view === 'continue' ? shown.offer : null;
}

function untilView(flow: WindowFlow, view: WindowView): Promise<void> {
  return untilScreen(flow, current => current.view === view);
}

function untilPairing(flow: WindowFlow, kind: SignInScreen['pairing']['kind']): Promise<void> {
  return untilScreen(flow, current => current.pairing.kind === kind);
}

describe('session window flow', () => {
  it('As a user in the sign-in window, I see nothing to press and nothing is read before the opener is vetted', () => {
    // Given a sign-in window that is still waiting for its opener

    // When the window opens and no hello arrives
    const { flow, calls, presence } = harness();

    // Then it connects with nothing offered, read or flagged
    expect(flow.screen.get().view).toBe('connecting');
    expect(flow.screen.get()).not.toHaveProperty('offer');
    expect(flow.screen.get().pageHost).toBeNull();
    expect(calls).toEqual([]);
    expect(presence.calls).toEqual([]);
  });

  it('As a user in a sign-in window that refused its opener, I see the refused view and nothing starts', () => {
    // Given a window not yet vetted
    const { flow, refuse, calls } = harness();

    // When the opener is refused
    refuse();

    // Then the refused view shows and nothing ran
    expect(flow.screen.get().view).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window with a stored session, I press Continue and the session is sent', async () => {
    // Given a main store holding a paired session
    const { flow, sent, vet, presence, calls, closed } = harness({ stored: { session: BLOB, uiState: UI_STATE } });

    // When the opener is vetted
    vet();
    await untilView(flow, 'continue');

    // Then Continue offers the paired account
    expect(offerOn(flow)).toEqual({
      wallet: 'paired',
      account: { publicKey: '0x01', liteUsername: 'alice.01' },
    });

    // When the flag is cleared elsewhere and the user presses Continue
    void presence.clear();
    await flow.continueWithStored();
    await closed;

    // Then the flag is set again and the window closes once it has sent what the store holds
    expect(presence.state).toBe('present');
    expect(sent()).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
    expect(calls).toEqual(['close']);
  });

  it('As a user in the sign-in window with a stored session and a local wallet, I am offered the local wallet and press Continue to send it', async () => {
    // Given a main store holding a paired session and a local wallet
    const { flow, sent, vet, closed } = harness({
      stored: { session: BLOB, uiState: UI_STATE, wallet: { entropy: ENTROPY, identity: IDENTITY } },
    });

    // When the opener is vetted
    vet();
    await untilView(flow, 'continue');

    // Then Continue offers the local wallet's account
    expect(offerOn(flow)).toEqual({
      wallet: 'local',
      account: { identityAccountId: '5Grwva', liteUsername: 'bob.02', primaryUsername: 'bob.02' },
    });

    // When the user presses Continue
    await flow.continueWithStored();
    await closed;

    // Then the session and the wallet are sent together
    expect(sent()).toEqual([
      { session: { blob: BLOB, uiState: UI_STATE }, localWallet: { entropy: ENTROPY, identity: IDENTITY } },
    ]);
  });

  it('As a user in the sign-in window with a wallet that has no identity, I see no names and Continue shows the generic label', async () => {
    // Given a main store holding only a wallet with no identity
    const { flow, vet } = harness({ stored: { wallet: { entropy: ENTROPY, identity: null } } });

    // When the opener is vetted
    vet();
    await untilView(flow, 'continue');

    // Then Continue offers the local wallet with no account
    expect(offerOn(flow)).toEqual({ wallet: 'local', account: null });
  });

  it('As a user in the sign-in window, I pair and the cookie is left to the core while the session it stored is sent', async () => {
    // Given an empty main store
    const { flow, sent, vet, presence, auth, calls, closed, storeSession, answerLogin, main } = harness();

    // When the opener is vetted
    vet();
    await untilView(flow, 'pairing');

    // Then the flag claims no sign-in while nothing is stored, the window asks its core to pair and names the page
    expect(presence.state).toBe('absent');
    expect(calls).toEqual(['login']);
    expect(flow.screen.get().pageHost).toBe('browse.dot.li');

    // When the core pairs, stores the session it paired and reports it, and my login answers
    auth.set(PAIRING);
    await storeSession(BLOB);
    auth.set({ tag: 'Authenticating' });
    auth.set(CONNECTED);
    answerLogin();
    await closed;

    // Then the flow itself set nothing, since the core's own write raised the flag before and after the session landed
    expect(presence.calls).toEqual(['clear', 'set', 'set']);
    expect(sent()).toEqual([{ session: { blob: BLOB, uiState: JSON.stringify(PAIRED_ACCOUNT) }, localWallet: null }]);
    // And the main store caches the paired account, so a page with no core and a later Continue show my name
    expect(main.uiState).toBe(JSON.stringify(PAIRED_ACCOUNT));
  });

  it('As a user in the sign-in window, I abandon pairing and the cookie stays unset', async () => {
    // Given a window pairing with its code on show
    const { flow, vet, presence, auth, calls } = harness();
    vet();
    await untilView(flow, 'pairing');
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
    const { flow, sent, vet, auth, closed, storeSession, answerLogin } = harness();
    vet();
    await untilView(flow, 'pairing');
    auth.set(PAIRING);
    await storeSession(BLOB);

    // When the core reports Connected
    auth.set(CONNECTED);
    await flow.settled();

    // Then nothing went out on the report alone
    expect(sent()).toEqual([]);

    // When the login answers
    answerLogin();
    await closed;

    // Then the paired session is sent once
    expect(sent()).toEqual([{ session: { blob: BLOB, uiState: JSON.stringify(PAIRED_ACCOUNT) }, localWallet: null }]);
  });

  it('As a user in the sign-in window, I press Cancel and the cookie stays while the main store holds a sign-in', async () => {
    // Given a window on Continue over a stored session
    const { flow, vet, presence, calls } = harness({ stored: { session: BLOB } });
    vet();
    await untilView(flow, 'continue');

    // When the user presses Cancel
    flow.cancel();

    // Then the flag is not touched and the window closes
    expect(presence.calls).toEqual([]);
    expect(calls).toEqual(['close']);
  });

  it('As a user in the sign-in window, I press Use another account and the phone is told, the store cleared and pairing started', async () => {
    // Given a window on Continue over a paired session and a local wallet
    const { flow, sent, vet, presence, auth, main, calls } = harness({
      stored: { session: BLOB, uiState: UI_STATE, wallet: { entropy: ENTROPY, identity: IDENTITY } },
      auth: CONNECTED,
    });
    vet();
    await untilView(flow, 'continue');

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the flow deletes the flag itself
    expect(calls).toEqual(['logout', 'forget', 'login']);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
    expect(presence.calls).toEqual(['clear']);
    expect(flow.screen.get().view).toBe('pairing');
    expect(flow.screen.get()).not.toHaveProperty('offer');
    expect(sent()).toEqual([]);

    // When the core starts pairing
    auth.set(PAIRING);

    // Then a pairing alone claims no sign-in
    expect(presence.state).toBe('absent');
  });

  it('As a user in the sign-in window with only a local wallet, I press Use another account and the wallet is forgotten and pairing starts', async () => {
    // Given a window on Continue over only a local wallet
    const { flow, vet, presence, main, calls } = harness({
      stored: { wallet: { entropy: ENTROPY, identity: null } },
    });
    vet();
    await untilView(flow, 'continue');

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the wallet is forgotten through the flag and pairing starts
    expect(calls).toEqual(['logout', 'forget', 'login']);
    expect(main.wallet).toBeNull();
    expect(presence.calls).toEqual(['clear']);
    expect(flow.screen.get().view).toBe('pairing');
  });

  it('As a user in the sign-in window whose sign-out could not tell the phone, I stay on Continue and pair only once a retry told it', async () => {
    // Given a window on Continue whose phone cannot be told
    const { flow, vet, calls, failures, main } = harness({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: null } },
      auth: CONNECTED,
    });
    vet();
    await untilView(flow, 'continue');
    failures.phone = true;

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the store let the session go, but the window waits for the phone and keeps the wallet
    expect(flow.screen.get().view).toBe('continue');
    expect(flow.screen.get().failure).toBe('phone');
    expect(calls).toEqual(['logout']);
    expect(main.session).toBeNull();
    expect(main.wallet).not.toBeNull();

    // When the user tries again and the phone hears of the same session
    failures.phone = false;
    await flow.useAnotherAccount();

    // Then pairing starts with no failure once the phone was told
    expect(flow.screen.get().view).toBe('pairing');
    expect(flow.screen.get().failure).toBeNull();
    expect(calls).toEqual(['logout', 'tell again', 'forget', 'login']);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
  });

  it('As a user in the sign-in window whose sign-out could not tell the phone, I go on to another account without it and pairing starts', async () => {
    // Given a window on Continue whose phone could not be told
    const { flow, vet, calls, failures, main } = harness({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: null } },
      auth: CONNECTED,
    });
    vet();
    await untilView(flow, 'continue');
    failures.phone = true;
    await flow.useAnotherAccount();

    // When the user goes on without the phone
    await flow.goOnWithoutPhone();

    // Then the store is emptied and pairing starts
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['logout', 'forget', 'login']);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
  });

  it('As a user in the sign-in window whose phone missed my sign-out, I press Try again and each press tells it once more', async () => {
    // Given a window whose phone missed the sign-out
    const { flow, vet, calls, failures } = harness({ stored: { session: BLOB }, auth: CONNECTED });
    vet();
    await untilView(flow, 'continue');
    failures.phone = true;
    await flow.useAnotherAccount();

    // When the user presses Try again twice
    await flow.useAnotherAccount();
    await flow.useAnotherAccount();

    // Then each press tells the phone again and the failure stays
    expect(calls).toEqual(['logout', 'tell again', 'tell again']);
    expect(flow.screen.get().failure).toBe('phone');
  });

  it('As a user in the sign-in window going on after my phone was missed, I stay on Continue when the main store cannot be read', async () => {
    // Given a window whose phone missed the sign-out over a store that cannot be read
    const { flow, vet, calls, failures } = harness({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: null } },
      auth: CONNECTED,
    });
    vet();
    await untilView(flow, 'continue');
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
    const { flow, vet, calls } = harness({ stored: { session: BLOB }, auth: CONNECTED });
    vet();
    await untilView(flow, 'continue');

    // When the user goes on without the phone
    await flow.goOnWithoutPhone();

    // Then the window stays on Continue and nothing ran
    expect(flow.screen.get().view).toBe('continue');
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window whose wallet could not be forgotten, I am offered it again and told so while the cookie stays', async () => {
    // Given a window on Continue whose wallet cannot be forgotten
    const { flow, vet, presence, calls, failures, metrics, errors } = harness({
      stored: { session: BLOB, wallet: { entropy: ENTROPY, identity: IDENTITY } },
      auth: CONNECTED,
    });
    vet();
    await untilView(flow, 'continue');
    failures.forget = new Error('frame down');

    // When the user presses Use another account
    await flow.useAnotherAccount();

    // Then the flag stays and Continue offers the wallet again with the failure
    expect(calls).toEqual(['logout', 'forget']);
    expect(presence.state).toBe('present');
    expect(flow.screen.get().view).toBe('continue');
    expect(offerOn(flow)).toEqual({
      wallet: 'local',
      account: { identityAccountId: '5Grwva', liteUsername: 'bob.02', primaryUsername: 'bob.02' },
    });
    expect(flow.screen.get().failure).toBe('sign-out');
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'forget' }]);
    expect(errors).toHaveLength(1);
  });

  it('As a user in the sign-in window whose Continue failed, I see the failed view with Try again and the failure is reported', async () => {
    // Given a window on Continue over a store that cannot be read
    const { flow, sent, vet, failures, metrics, errors } = harness({ stored: { session: BLOB } });
    vet();
    await untilView(flow, 'continue');
    failures.read = new Error('store down');

    // When the user presses Continue
    await flow.continueWithStored();

    // Then nothing is sent and the failed view shows, counted and logged
    expect(sent()).toEqual([]);
    expect(flow.screen.get().view).toBe('failed');
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'continue' }]);
    expect(errors).toHaveLength(1);

    // When the store answers again and the user presses Try again
    failures.read = null;
    await flow.retry();

    // Then Continue is offered again
    expect(flow.screen.get().view).toBe('continue');
  });

  it('As a user in the sign-in window whose first step failed, I am told so instead of waiting and Retry decides again', async () => {
    // Given a window over a store that cannot be read
    const { flow, vet, failures, metrics, errors } = harness({ stored: { session: BLOB } });
    failures.read = new Error('store down');

    // When the opener is vetted
    vet();
    await flow.settled();

    // Then the failed view shows, counted and logged
    expect(flow.screen.get().view).toBe('failed');
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'decide' }]);
    expect(errors).toHaveLength(1);

    // When the store answers again and the user presses Retry
    failures.read = null;
    await flow.retry();

    // Then Continue offers the stored session
    expect(flow.screen.get().view).toBe('continue');
    expect(offerOn(flow)).toEqual({ wallet: 'paired', account: null });
  });

  it('As a user in the sign-in window whose finish failed after pairing, I am told so and Retry offers the session it stored', async () => {
    // Given a window pairing over a store that cannot be read
    const { flow, vet, auth, failures, storeSession, metrics, answerLogin } = harness();
    vet();
    await untilView(flow, 'pairing');
    auth.set(PAIRING);
    failures.read = new Error('store down');

    // When the core connects and the login answers
    auth.set(CONNECTED);
    answerLogin();
    await untilView(flow, 'failed');

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
    const { flow, failures } = harness({ vetted: 'phrase' });
    await untilView(flow, 'phrase');
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
    const { flow, vet, calls } = harness();
    vet();
    await untilView(flow, 'pairing');

    // When the user presses Retry
    await flow.retry();

    // Then the window keeps pairing with its one login
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['login']);
  });

  it('As a user in the sign-in window, I import a phrase and it replaces the wallet, keeps the paired session and sends both', async () => {
    // Given a phrase window over a paired session and a local wallet
    const { flow, sent, presence, main, calls, closed } = harness({
      vetted: 'phrase',
      stored: { session: BLOB, uiState: UI_STATE, wallet: { entropy: ENTROPY, identity: IDENTITY } },
    });
    await untilView(flow, 'phrase');
    void presence.clear();
    const walletWhenSet: (Uint8Array | undefined)[] = [];
    const set = presence.set.bind(presence);
    presence.set = () => {
      walletWhenSet.push(main.wallet?.entropy);
      return set();
    };

    // When the user imports a phrase
    await flow.importPhrase(PHRASE);
    await closed;

    // Then the flag was set before the new wallet was saved, and the new wallet replaced the old one
    expect(walletWhenSet[0]).toBe(ENTROPY);
    expect(presence.state).toBe('present');
    expect(calls).toEqual(['save', 'close']);
    expect(main.wallet).toEqual({ entropy: PHRASE_ENTROPY, identity: null });
    expect(main.session).toBe(BLOB);
    expect(sent()).toEqual([
      { session: { blob: BLOB, uiState: UI_STATE }, localWallet: { entropy: PHRASE_ENTROPY, identity: null } },
    ]);
  });

  it('As a user in the sign-in window whose wallet could not be saved, I see the form say so and the failure is reported and the cookie deleted', async () => {
    // Given a phrase window whose wallet save fails
    const { flow, sent, presence, failures, metrics, errors } = harness({ vetted: 'phrase' });
    await untilView(flow, 'phrase');
    failures.save = new Error('quota');

    // When the user imports a phrase
    const imported = flow.importPhrase(PHRASE);

    // Then the import rejects, nothing is sent, the flag goes back down and the failure is counted
    await expect(imported).rejects.toThrow('The recovery phrase wallet could not be saved');
    expect(sent()).toEqual([]);
    expect(flow.screen.get().view).toBe('phrase');
    expect(presence.calls).toEqual(['set', 'clear']);
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'save' }]);
    expect(errors).toHaveLength(1);
  });

  it('As a user in the sign-in window whose store cannot be read after my phrase wallet saved, I see the failed view and the form is not told the save failed', async () => {
    // Given a phrase window over a store that cannot be read, which nothing reads before the wallet saves
    const { flow, sent, failures, metrics } = harness({ vetted: 'phrase' });
    await untilView(flow, 'phrase');
    failures.read = new Error('store down');

    // When the user imports a phrase
    await flow.importPhrase(PHRASE);

    // Then the import resolves on the failed view, nothing is sent and the failed read is counted
    expect(flow.screen.get().view).toBe('failed');
    expect(sent()).toEqual([]);
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'phrase' }]);
  });

  it('As a user in the sign-in window whose store could not be read after my phrase wallet saved, I press Try again and see the phrase form', async () => {
    // Given a phrase window on the failed view, as the store could not be read after the wallet saved
    const { flow, sent, failures } = harness({ vetted: 'phrase' });
    await untilView(flow, 'phrase');
    failures.read = new Error('store down');
    await flow.importPhrase(PHRASE);
    expect(flow.screen.get().view).toBe('failed');

    // When the store answers again and Try again is pressed
    failures.read = null;
    await flow.retry();

    // Then the window decides the phrase intent again and shows the phrase form, with nothing sent
    expect(flow.screen.get().view).toBe('phrase');
    expect(sent()).toEqual([]);
  });

  it('As a user in the sign-in window, I enter a phrase that is not one and it is reported and touches nothing', async () => {
    // Given a phrase window
    const { flow, sent, presence, calls, metrics } = harness({ vetted: 'phrase' });
    await untilView(flow, 'phrase');

    // When the user imports a phrase that is not one
    const imported = flow.importPhrase('not a phrase');

    // Then the import rejects, nothing is touched or sent and the failure is counted
    await expect(imported).rejects.toThrow('Not a valid recovery phrase');
    expect(calls).toEqual([]);
    expect(presence.calls).toEqual([]);
    expect(sent()).toEqual([]);
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'phrase' }]);
  });

  it('As a debug panel user, I see no phrase form until the phrase check has loaded', async () => {
    // Given a phrase check still on its way
    const called = deferred<undefined>();
    const check = deferred<PhraseCheck>();
    const { flow } = harness({
      vetted: 'phrase',
      loadPhrase: () => {
        called.resolve(undefined);
        return check.promise;
      },
    });
    await called.promise;

    // Then the window still connects and takes no phrase
    expect(flow.screen.get().view).toBe('connecting');
    expect(flow.isValidPhrase(PHRASE)).toBe(false);

    // When the check loads
    check.resolve(PHRASE_CHECK);
    await untilView(flow, 'phrase');

    // Then the check takes only the valid phrase
    expect(flow.isValidPhrase(PHRASE)).toBe(true);
    expect(flow.isValidPhrase('not a phrase')).toBe(false);
  });

  it('As a debug panel user whose phrase check failed to load, I see the failure and Retry loads it again', async () => {
    // Given a phrase check that fails to load once
    let loads = 0;
    const { flow, metrics } = harness({
      vetted: 'phrase',
      loadPhrase: () => {
        loads += 1;
        return loads === 1 ? Promise.reject(new Error('chunk missing')) : Promise.resolve(PHRASE_CHECK);
      },
    });

    // When the first load fails
    await untilView(flow, 'failed');

    // Then the miss is counted once under the missed-chunk count, not the flow's
    expect(metrics.counted('lazy_chunk.load')).toEqual([{ outcome: 'error', reason: 'phrase_import' }]);
    expect(metrics.counted('session_window.flow')).toEqual([]);
    expect(flow.isValidPhrase(PHRASE)).toBe(false);

    // When the user presses Retry
    await flow.retry();

    // Then the check loads again and the phrase view shows
    expect(loads).toBe(2);
    expect(flow.screen.get().view).toBe('phrase');
    expect(flow.isValidPhrase(PHRASE)).toBe(true);
  });

  it('As a user in the sign-in window opened for a phrase with nothing stored, I press Back and pairing starts', async () => {
    // Given a phrase window over an empty store
    const { flow, calls } = harness({ vetted: 'phrase' });
    await untilView(flow, 'phrase');

    // When the user presses Back
    await flow.closePhrase();

    // Then pairing starts
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['login']);
  });

  it('As a user in the sign-in window opened for a phrase with a stored session, I press Back and am offered Continue', async () => {
    // Given a phrase window over a stored session
    const { flow } = harness({ vetted: 'phrase', stored: { session: BLOB } });
    await untilView(flow, 'phrase');

    // When the user presses Back
    await flow.closePhrase();

    // Then Continue offers the stored session
    expect(flow.screen.get().view).toBe('continue');
    expect(offerOn(flow)).toEqual({ wallet: 'paired', account: null });
  });

  it('As a user in a sign-in window with no opener, I sign in against the main store and nothing is sent, which the window says', async () => {
    // Given a window with no opener, pairing
    const { flow, sent, auth, calls, storeSession, answerLogin } = harness({ opener: false });
    await untilView(flow, 'pairing');

    // When the core pairs and stores the session and the login answers
    auth.set(PAIRING);
    await storeSession(BLOB);
    auth.set(CONNECTED);
    answerLogin();
    await untilView(flow, 'done-no-opener');

    // Then nothing is sent and no page is named
    expect(flow.screen.get().pageHost).toBeNull();
    expect(sent()).toEqual([]);
    expect(calls).toEqual(['login']);
  });

  it('As a user in a sign-in window with no opener whose URL asks for a phrase, I open it and see the phrase view first', async () => {
    // Given a window with no opener whose URL asks for a phrase
    const { flow, calls } = harness({ opener: false, urlIntent: 'phrase' });

    // When the flow settles
    await flow.settled();

    // Then the phrase view shows and no login starts
    expect(flow.screen.get().view).toBe('phrase');
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window whose store was emptied before Continue, I press Continue and pair instead of sending nothing', async () => {
    // Given a window on Continue whose store was emptied since
    const { flow, sent, vet, main, calls } = harness({ stored: { session: BLOB } });
    vet();
    await untilView(flow, 'continue');
    main.session = null;

    // When the user presses Continue
    await flow.continueWithStored();

    // Then pairing starts and nothing is sent
    expect(flow.screen.get().view).toBe('pairing');
    expect(sent()).toEqual([]);
    expect(calls).toEqual(['login']);
  });

  it('As a user in a restored sign-in window, I return to it and the same round vetted again leaves my view as it was', async () => {
    // Given one window on Continue and one pairing
    const stored = harness({ stored: { session: BLOB } });
    stored.vet();
    await untilView(stored.flow, 'continue');
    const pairing = harness();
    pairing.vet();
    await untilView(pairing.flow, 'pairing');

    // When both are restored and their opener vets the same round again
    for (const window of [stored, pairing]) {
      window.restore();
      window.vet();
      await window.flow.settled();
    }

    // Then nothing was decided again and no second pairing started
    expect(stored.flow.screen.get().view).toBe('continue');
    expect(stored.calls).toEqual([]);
    expect(pairing.flow.screen.get().view).toBe('pairing');
    expect(pairing.calls).toEqual(['login']);
  });

  it('As a user pairing in a restored sign-in window, I return to it and a new round joins the login under way while Retry starts one only after it answered', async () => {
    // Given a window pairing, its code on show
    const { flow, vet, vetRound, restore, auth, calls, answerLogin } = harness();
    vet();
    await untilView(flow, 'pairing');
    auth.set(PAIRING);

    // When it is restored and its opener vets a new round
    restore();
    vetRound('r2');
    await flow.settled();

    // Then the round pairs on the login under way, whose code stays
    expect(calls).toEqual(['login']);
    expect(flow.screen.get().pairing).toEqual({ kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' });

    // When that login fails and Retry is pressed
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'Login request denied' });
    answerLogin({ kind: 'failed' });
    await untilPairing(flow, 'error');
    await flow.retry();

    // Then the joined round started no login of its own, and Retry started the one more
    expect(calls).toEqual(['login', 'login']);
    expect(flow.screen.get().pairing).toEqual({ kind: 'spinner' });
  });

  it('As a user in a restored sign-in window whose new round failed to decide while my code is on show, I press Retry and the code stays', async () => {
    // Given a window pairing with its code on show, restored into a new round whose read of the store fails
    const { flow, vet, vetRound, restore, auth, calls, failures } = harness();
    vet();
    await untilView(flow, 'pairing');
    auth.set(PAIRING);
    failures.read = new Error('frame down');
    restore();
    vetRound('r2');
    await untilView(flow, 'failed');

    // When the store answers again and Retry is pressed
    failures.read = null;
    await flow.retry();

    // Then the login under way still shows its code, and no second login started
    expect(flow.screen.get().view).toBe('pairing');
    expect(flow.screen.get().pairing).toEqual({ kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' });
    expect(calls).toEqual(['login']);
  });

  it('As a user in a restored sign-in window, I finish before it is vetted again and the result is sent then', async () => {
    // Given a restored window waiting for its opener again
    const { flow, sent, vet, restore, calls } = harness({ stored: { session: BLOB } });
    vet();
    await untilView(flow, 'continue');
    restore();

    // When the user presses Continue
    await flow.continueWithStored();

    // Then nothing went out yet, and the window stays open
    expect(sent()).toEqual([]);
    expect(calls).toEqual([]);

    // When the restored window is vetted again
    vet();

    // Then the result is sent then and the window closes
    expect(sent()).toEqual([{ session: { blob: BLOB, uiState: null }, localWallet: null }]);
    expect(calls).toEqual(['close']);
  });

  it('As a user in the sign-in window on a flag store that answers late, I press Continue and the session is sent only once the flag landed', async () => {
    // Given a window on Continue whose flag write is held
    const { flow, sent, vet, presence } = harness({ stored: { session: BLOB } });
    vet();
    await untilView(flow, 'continue');
    const landed = deferred<undefined>();
    const asked = deferred<undefined>();
    presence.set = () => {
      asked.resolve(undefined);
      return landed.promise;
    };

    // When the user presses Continue and the flag write is asked
    const continued = flow.continueWithStored();
    await asked.promise;

    // Then nothing is sent yet
    expect(sent()).toEqual([]);

    // When the flag write lands
    landed.resolve(undefined);
    await continued;

    // Then the session is sent
    expect(sent()).toHaveLength(1);
  });

  it('As a user in the sign-in window, I press Continue twice and the second press sends nothing more', async () => {
    // Given a window on Continue over a stored session
    const { flow, sent, vet, calls } = harness({ stored: { session: BLOB } });
    vet();
    await untilView(flow, 'continue');

    // When the user presses Continue twice at once
    await Promise.all([flow.continueWithStored(), flow.continueWithStored()]);

    // Then one result is sent and the window closes once
    expect(sent()).toHaveLength(1);
    expect(calls).toEqual(['close']);
  });

  it('As a user in the sign-in window, I see how far my pairing got and its failure stays through a disconnect while Retry pairs again', async () => {
    // Given a window pairing
    const { flow, vet, auth, calls, answerLogin } = harness();
    vet();
    await untilView(flow, 'pairing');

    // When the core shows its code, then fails, then reads signed out
    auth.set(PAIRING);
    const shownCode = flow.screen.get().pairing;
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'Login request denied' });
    auth.set({ tag: 'Disconnected' });

    // Then the code showed and the declined failure stays with Retry
    expect(shownCode).toEqual({ kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' });
    expect(flow.screen.get().pairing).toMatchObject({ kind: 'error', title: 'Sign-in was declined', retry: true });

    // When Retry is pressed before my login answered, and it answers that it failed
    const retried = flow.retry();
    answerLogin({ kind: 'failed' });
    await retried;

    // Then a new login started only once the failed one answered, and the failure gave way to a fresh pairing
    expect(flow.screen.get().pairing).toEqual({ kind: 'spinner' });
    expect(calls).toEqual(['login', 'login']);
  });

  it('As a user in the sign-in window whose core cancelled my login after showing its code, I am told the sign-in was cancelled and Retry pairs again', async () => {
    // Given a pairing whose code is on show
    const { flow, vet, auth, calls, answerLogin } = harness();
    vet();
    await untilView(flow, 'pairing');
    auth.set(PAIRING);

    // When the core ends the login with no failure of its own, and reads signed out
    answerLogin({ kind: 'cancelled' });
    auth.set({ tag: 'Disconnected' });
    await untilPairing(flow, 'error');

    // Then the dead code is gone and Retry is offered
    expect(flow.screen.get().pairing).toMatchObject({ kind: 'error', title: 'Sign-in was cancelled', retry: true });

    // When the user presses Retry
    await flow.retry();

    // Then a new login starts with the spinner
    expect(flow.screen.get().pairing).toEqual({ kind: 'spinner' });
    expect(calls).toEqual(['login', 'login']);
  });

  it('As a user in the sign-in window whose login failed with no word from the core, I am told so and the code goes', async () => {
    // Given a pairing whose code is on show
    const { flow, vet, auth, answerLogin } = harness();
    vet();
    await untilView(flow, 'pairing');
    auth.set(PAIRING);

    // When the login answers failed
    answerLogin({ kind: 'failed' });
    await untilPairing(flow, 'error');

    // Then the generic failure shows with Retry
    expect(flow.screen.get().pairing).toMatchObject({ kind: 'error', title: 'Sign-in did not complete', retry: true });
  });

  it('As a user in the sign-in window whose pairing could not be stored, I am told so and Retry pairs again', async () => {
    // Given a window pairing
    const { flow, vet, calls, metrics, failLogin } = harness();
    vet();
    await untilView(flow, 'pairing');

    // When the command layer says the paired session could not be stored
    failLogin(new Error('The paired session could not be stored'));
    await untilView(flow, 'failed');

    // Then the pairing failure is counted
    expect(metrics.counted('session_window.flow')).toEqual([{ outcome: 'error', reason: 'pairing' }]);

    // When the user presses Retry
    await flow.retry();

    // Then nothing is stored, so the window pairs again
    expect(flow.screen.get().view).toBe('pairing');
    expect(calls).toEqual(['login', 'login']);
  });

  it('As a user in the sign-in window on Continue, I see my core pick up a sign-in from elsewhere and nothing is sent by itself', async () => {
    // Given no login of mine runs
    const { flow, vet, auth, sent, calls } = harness({ stored: { session: BLOB } });
    vet();
    await untilView(flow, 'continue');

    // When the core reports Connected
    auth.set(CONNECTED);
    await flow.settled();

    // Then the user still chooses
    expect(flow.screen.get().view).toBe('continue');
    expect(sent()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('As a user in the sign-in window, I press Continue and the account it offered is sent without reading it again', async () => {
    // Given a window on Continue over a session with its account
    const { flow, vet, sent, reads, closed } = harness({ stored: { session: BLOB, uiState: UI_STATE } });
    vet();
    await untilView(flow, 'continue');

    // When the user presses Continue
    await flow.continueWithStored();
    await closed;

    // Then the account was read once and sent with the session
    expect(reads.uiCache).toBe(1);
    expect(sent()).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
  });

  it('As a user in the sign-in window whose store took another sign-in before Continue, I press Continue and that one is sent with its own account', async () => {
    // Given a window on Continue whose store took another session since
    const { flow, vet, main, sent, closed } = harness({ stored: { session: BLOB, uiState: UI_STATE } });
    vet();
    await untilView(flow, 'continue');
    const otherAccount = JSON.stringify(PAIRED_ACCOUNT);
    main.session = '0xother';
    main.uiState = otherAccount;

    // When the user presses Continue
    await flow.continueWithStored();
    await closed;

    // Then the new session is sent with its own account
    expect(sent()).toEqual([{ session: { blob: '0xother', uiState: otherAccount }, localWallet: null }]);
  });

  it('As a user in the sign-in window whose stored wallet was signed out elsewhere before Continue, I press Continue and pair instead', async () => {
    // Given a window on Continue whose stored wallet was forgotten since
    const { flow, vet, main, sent, calls } = harness({ stored: { wallet: { entropy: ENTROPY, identity: null } } });
    vet();
    await untilView(flow, 'continue');
    main.wallet = null;

    // When the user presses Continue
    await flow.continueWithStored();

    // Then pairing starts and nothing is sent
    expect(flow.screen.get().view).toBe('pairing');
    expect(sent()).toEqual([]);
    expect(calls).toEqual(['login']);
  });

  describe('resuming a sign-in made elsewhere', () => {
    it('As a user in a sign-in window a page asked to resume, I am not offered Continue and the stored session is sent at once after the flag landed', async () => {
      // Given a window over a stored session with its views and flag writes recorded
      const { flow, sent, vet, presence, calls, closed } = harness({ stored: { session: BLOB, uiState: UI_STATE } });
      const views: WindowView[] = [];
      flow.screen.subscribe(() => {
        views.push(flow.screen.get().view);
      });
      const order: string[] = [];
      presence.set = () => {
        order.push(`flag with ${String(sent().length)} sent`);
        presence.state = 'present';
        return Promise.resolve();
      };

      // When a page asks it to resume
      vet('resume');
      await closed;

      // Then the session is sent after the flag, with no Continue on show
      expect(sent()).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
      expect(order[0]).toBe('flag with 0 sent');
      expect(presence.state).toBe('present');
      expect(views).not.toContain('continue');
      expect(calls).toEqual(['close']);
    });

    it('As a user in a sign-in window a page asked to resume, I am not offered Continue and a stored local wallet is sent with the paired session', async () => {
      // Given a window over a paired session and a local wallet
      const { sent, vet, closed } = harness({
        stored: { session: BLOB, uiState: UI_STATE, wallet: { entropy: ENTROPY, identity: IDENTITY } },
      });

      // When a page asks it to resume
      vet('resume');
      await closed;

      // Then the session and the wallet are sent together
      expect(sent()).toEqual([
        { session: { blob: BLOB, uiState: UI_STATE }, localWallet: { entropy: ENTROPY, identity: IDENTITY } },
      ]);
    });

    it('As a user in a sign-in window asked to resume over an empty store, I fall back to signing in and the stale flag is dropped', async () => {
      // Given a window over an empty store
      const { flow, sent, vet, presence, calls } = harness();

      // When a page asks it to resume
      vet('resume');
      await untilView(flow, 'pairing');

      // Then nothing is sent, the flag drops and pairing starts for the page
      expect(sent()).toEqual([]);
      expect(presence.state).toBe('absent');
      expect(calls).toEqual(['login']);
      expect(flow.screen.get().pageHost).toBe('browse.dot.li');
    });

    it('As a user in a sign-in window whose resume failed, I am told so and Retry sends the stored sign-in', async () => {
      // Given a resume that failed on a store that could not be read
      const { flow, sent, vet, failures, closed } = harness({ stored: { session: BLOB, uiState: UI_STATE } });
      failures.read = new Error('frame unavailable');
      vet('resume');
      await untilView(flow, 'failed');

      // When the store recovers and the user presses Retry
      failures.read = null;
      await flow.retry();
      await closed;

      // Then the stored session is sent
      expect(sent()).toEqual([{ session: { blob: BLOB, uiState: UI_STATE }, localWallet: null }]);
    });
  });
});
