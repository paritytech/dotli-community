// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId, type ProductAccountId } from '@parity/truapi';
import { atom, type ReadableAtom } from 'nanostores';
import { describe, expect, it, onTestFinished } from 'vitest';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred, fromHex, isRecord, toHex, waitForStatus } from '@dotli/shared';
import { catchError, must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore } from '@dotli/storage';
import { createMemorySiteGrantsIdb } from '@dotli/storage/testing';
import { createVettedResponder } from '../sessionHandoff/createResponder.fake.js';
import { createWindowFlow, type WindowFlow, type WindowFlowParams } from '../sessionHandoff/createWindowFlow.js';
import type { DotliAuthState } from '../session/types.js';
import { createFakeSessionPresence } from '../session/createPagePresence.fake.js';
import { createOwnerSignInFlag } from '../session/signInFlag.js';
import { findLeakedSecrets, MAIN_BLOB, WALLET_ACCOUNT, WALLET_ENTROPY } from '../../testing/findLeakedSecrets.js';
import { MAIN_KEY } from '../../testing/siteRoundConstants.js';
import { MainAccountError, getMainAccount, type MainAccount } from './mainAccount.js';
import type { SignInScreen } from '../../state/sessionWindowState.js';
import type { DisplayCall } from './toDisplayCall.js';
import type { SiteChain } from './createSiteChain.js';
import type { SiteSignRequest } from './parseSiteSignRequest.js';
import type { SiteAccountReader } from './createSiteAccountReader.js';
import { openSiteSignIn, openSiteTransaction, type SiteWindow, type SiteWindowParams } from './siteWindow.js';

type CreateWindowPartsParams = {
  /** How the window's core reports the main account, as `MAIN` by default. */
  mainAccount?: SiteWindowParams['mainAccount'];
  /** Makes each window flow's own `dispose` do nothing, so only the window's own release of the flow is left. */
  leaveFlowsRunning?: boolean;
  /** Holds each read of the main session until it settles, which keeps a window flow open. */
  sessionReadHeld?: Promise<void>;
  /** Shows this screen source in place of each window flow's own, which the window flow keeps running behind it. */
  flowScreen?: ReadableAtom<SignInScreen>;
  /** Makes the first window flow throw as it starts. */
  firstFlowStartFails?: boolean;
};

type OpenTransactionWindowParams = {
  /** A read of the old token's grant that waits for it, which makes the request carry that token. */
  grantRead?: Promise<void>;
};

/** What a site's window flow calls once it stored a sign-in. */
type SiteWindowFlowDeliver = Parameters<SiteWindowParams['createWindowFlow']>[0]['deliver'];

/** One view the window showed, with the page or route it names. */
type ShownView = { view: string; pageHost?: string | null; route?: string };

const SELF = 'https://dot.li';
const ORIGIN = 'https://my-site.com';
const NETWORK_NAME = 'paseo-next-v2';
const SERVICES = NETWORK_NAME_TO_SERVICES_CONFIG[NETWORK_NAME];
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: asProductId(`myapp.${SERVICES.dotns.TLD}`),
  derivationIndex: { tag: 'Index', value: 0 },
};
const NOW = Date.parse('2026-10-23T15:00:00.000Z');

const MAIN_SESSION = { connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot' };
const MAIN_UI_STATE = JSON.stringify(MAIN_SESSION);
/** The main account the window's core reports, read as the window reads it. */
const MAIN: MainAccount = must(getMainAccount(MAIN_SESSION), 'the main account');

const SITE_KEY = new Uint8Array(32).fill(0x22);
const TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
/** A token the site kept from an earlier round, which names no grant this store keeps. */
const OLD_TOKEN = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';

const CONNECTED: DotliAuthState = { tag: 'Connected', session: { connected: true, publicKey: MAIN_KEY } };
const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' };

const CALL = '0x0a0300010203';
const PAYLOAD_CALL = '0x0a0300040506';
const DISPLAY: DisplayCall = { name: 'Balances.transfer_keep_alive', args: [{ name: 'value', value: '1' }] };
/** The signed transaction the fake chain builds. */
const SIGNED_TX = `0x${'5e'.repeat(80)}`;

/** An account reader that reads the site account at once. */
const ACCOUNT_READER: SiteAccountReader = {
  account: () => Promise.resolve(SITE_KEY),
};

/**
 * A session window over fakes for a site's round: the opener and its messages, a main store that holds a paired
 * session and a local wallet, the window's auth state, the main account its core reports through `mainAccount` and an
 * in-memory grants store, with the window's real responder and real window flows, each kept in `flows`. The site said
 * hello, so the window is vetted.
 */
function createWindowParts({
  mainAccount = () => Promise.resolve(MAIN),
  leaveFlowsRunning = false,
  sessionReadHeld = Promise.resolve(),
  flowScreen,
  firstFlowStartFails = false,
}: CreateWindowPartsParams = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  recordLog({ onFinished: onTestFinished, level: 'error' });
  const { responder, opener, post } = createVettedResponder({ origin: ORIGIN, self: SELF });
  const signIns = createOwnerSignInFlag({
    presence: createFakeSessionPresence({ state: 'present' }),
    readStoredSignIn: () => Promise.resolve('held'),
  });
  // The window resumes what is stored, so it never pairs or signs out.
  const commands: WindowFlowParams['commands'] = {
    login: () => Promise.reject(new Error('The window paired')),
  };
  const signOut: WindowFlowParams['signOut'] = {
    signOut: () => Promise.reject(new Error('The window signed out')),
    tellAgain: () => Promise.reject(new Error('The window told the phone again')),
  };
  const closed = createDeferred<undefined>();
  const auth = atom<DotliAuthState>(CONNECTED);
  const flows: WindowFlow[] = [];
  // What each window flow was told to do once it stored a sign-in.
  const deliveries: SiteWindowFlowDeliver[] = [];
  let starts = 0;
  const params: Omit<SiteWindowParams, 'request'> = {
    origin: ORIGIN,
    self: SELF,
    responder,
    createWindowFlow(flow) {
      starts += 1;
      if (firstFlowStartFails && starts === 1) {
        throw new Error('The window flow could not start');
      }
      const started = createWindowFlow({
        signIns,
        auth,
        commands,
        signOut,
        store: {
          readSession: async () => {
            await sessionReadHeld;
            return { status: 'ok', blob: MAIN_BLOB };
          },
          readUiCache: () => Promise.resolve(MAIN_UI_STATE),
          writeUiCache: () => Promise.resolve(),
        },
        wallet: {
          read: (): Promise<LocalWalletReadResult> =>
            Promise.resolve({
              status: 'ok',
              entropy: WALLET_ENTROPY,
              identity: { identityAccountId: WALLET_ACCOUNT, liteUsername: 'alice.01' },
              version: Uint8Array.of(1),
            }),
          save: () => Promise.reject(new Error('The window saved a wallet')),
          forget: () => Promise.reject(new Error('The window forgot the wallet')),
        },
        loadPhrase: () => Promise.reject(new Error('The window loaded the phrase check')),
        ...flow,
      });
      flows.push(started);
      deliveries.push(flow.deliver);
      return {
        ...started,
        screen: flowScreen ?? started.screen,
        dispose: leaveFlowsRunning
          ? () => undefined
          : () => {
              started.dispose();
            },
      };
    },
    grants: createSiteGrantStore({ idb: createMemorySiteGrantsIdb() }),
    groups: {
      registrable: () => Promise.reject(new Error('The window loaded the suffix list for a site of no group')),
    },
    mainAccount,
    now: () => NOW,
    randomToken: () => TOKEN,
    close() {
      closed.resolve(undefined);
    },
  };
  return {
    params,
    metrics,
    auth,
    flows,
    deliveries,
    /** How many listeners the window flows' own screens hold. */
    countFlowScreenListeners: (): number => flows.reduce((count, flow) => count + flow.screen.lc, 0),
    closed: closed.promise,
    /** Every message the opener got, ready included. */
    readPosted: () => opener.posted.map(({ message }) => message),
    /** The site posts `call` as the round's payload. */
    postPayload(call: string): void {
      // A third-party site writes its payload itself, with no dotli builder, so this stands in for that site's wire.
      post({ data: { type: 'dotli:s:payload', round: 'r1', call }, origin: ORIGIN, source: opener });
    },
  };
}

/** What the window showed of `window`, each view with the page or route it names, from now on. */
function watchWindow({ site, screen, dispose }: SiteWindow) {
  const shown: ShownView[] = [];
  onTestFinished(
    screen.subscribe(next => {
      shown.push(getShownView(next));
    }),
  );
  return {
    site,
    screen,
    dispose,
    shown,
    /** Resolves once the window shows `view`. */
    waitForView: (view: string) => waitForStatus(screen, current => current.view === view),
  };
}

/** A view as the window showed it, with the page or route it names. */
function getShownView(current: ReturnType<SiteWindow['screen']['get']>): ShownView {
  if ('pageHost' in current) {
    return { view: current.view, pageHost: current.pageHost };
  }
  if ('route' in current) {
    return { view: current.view, route: current.route };
  }
  return { view: current.view };
}

/**
 * A site's sign-in in a session window over the window's parts, whose core reports the main account as `mainAccount`
 * says.
 */
function openSignInWindow(options: CreateWindowPartsParams = {}) {
  const parts = createWindowParts(options);
  const opened = openSiteSignIn({ ...parts.params, request: { round: 'r1', siteToken: null, groupToken: null } });
  return { ...parts, ...watchWindow(opened) };
}

/** Asset Hub that decodes any call and builds its signed transaction, recording each call it decodes as hex. */
function createFakeChain() {
  const decoded: string[] = [];
  const chain: SiteChain = {
    open: () =>
      Promise.resolve({
        decode(call) {
          decoded.push(toHex(call));
          return Promise.resolve({
            display: DISPLAY,
            transaction: { create: () => Promise.reject(new Error('The fake chain builds through its session')) },
          });
        },
        create: () => Promise.resolve(fromHex(SIGNED_TX)),
        close: () => undefined,
      }),
  };
  return { chain, decoded };
}

/**
 * A site's transaction window over the window's parts, a chain that builds it and an account reader that reads the site account,
 * for a request that carries `call` or leaves it to a payload. `asked` resolves once the window asked for the payload.
 */
function openTransactionWindow(call: string | null, { grantRead }: OpenTransactionWindowParams = {}) {
  const parts = createWindowParts();
  const { chain, decoded } = createFakeChain();
  const asked = createDeferred<undefined>();
  const request: SiteSignRequest = {
    round: 'r1',
    account: ACCOUNT,
    siteToken: grantRead === undefined ? null : OLD_TOKEN,
    groupToken: null,
    chain: SERVICES.assethub.genesis,
    call,
  };
  const { responder, grants } = parts.params;
  const opening = openSiteTransaction({
    ...parts.params,
    request,
    grants: {
      ...grants,
      async read(token) {
        await grantRead;
        return grants.read(token);
      },
    },
    responder: {
      ...responder,
      payload() {
        asked.resolve(undefined);
        return responder.payload();
      },
    },
    chain,
    accountReader: ACCOUNT_READER,
    txSigner: { creator: () => () => Promise.reject(new Error('The fake chain signs no transaction')) },
  });
  return { ...parts, decoded, asked: asked.promise, opening };
}

describe('site sign-in window', () => {
  it('As a user, I sign in to a site and never hand it my main session, main account or local wallet', async () => {
    // Given a main store with a paired session and a local wallet beside it, and a site on its consent view
    const page = openSignInWindow();
    await page.waitForView('consent');

    // When the user consents and the round runs to its result
    await page.site.consent();
    await page.closed;
    const leaked = findLeakedSecrets(page.readPosted());

    // Then the site got its one result, the main account's username alone, and no message it got carries any of them
    expect(page.readPosted().filter(message => isRecord(message) && message['type'] === 'dotli:s:result')).toEqual([
      { type: 'dotli:s:result', round: 'r1', result: { username: MAIN.username }, site_token: TOKEN },
    ]);
    expect(leaked).toEqual([]);
  });

  it("As a user, I consent to a site and see its consent, then the window flow's view naming the site by its full origin, then the signing", async () => {
    // Given a site on its consent view
    const page = openSignInWindow();
    await page.waitForView('consent');

    // When the user consents and the round runs to its result
    await page.site.consent();
    await page.closed;

    // Then the window showed the site's views, and the window flow's own while it resumed the main session
    expect(page.shown).toEqual([
      { view: 'site-signing', route: 'auth' },
      { view: 'consent' },
      { view: 'connecting', pageHost: ORIGIN },
      { view: 'site-signing', route: 'auth' },
    ]);
  });

  it('As a user whose stored session is gone, I press Try again and the window resumes the sign-in in a new flow', async () => {
    // Given a core that first reports the stored session gone, then the session the new flow resumes
    let reads = 0;
    const page = openSignInWindow({
      mainAccount: () => {
        reads += 1;
        return reads === 1
          ? Promise.reject(new MainAccountError('signed_out', 'The main session ended'))
          : Promise.resolve(MAIN);
      },
    });
    await page.waitForView('consent');
    await page.site.consent();
    await page.waitForView('site-failed');

    // When the user presses Try again
    await page.site.retry();
    await page.closed;

    // Then the window flow ran again, its view showed, and the site got its one result
    expect(page.shown.filter(shown => shown.view === 'connecting')).toHaveLength(2);
    expect(page.readPosted().filter(message => JSON.stringify(message).includes('dotli:s:result'))).toHaveLength(1);
  });

  it('As a user whose window flow throws as it starts, I see the failure with Try again', async () => {
    // Given a site on its consent view, whose first window flow throws as it starts
    const page = openSignInWindow({ firstFlowStartFails: true });
    await page.waitForView('consent');

    // When the user consents, then presses Try again
    await page.site.consent();
    const failed = page.screen.get();
    await page.site.retry();
    await page.closed;

    // Then the window showed the failure with Try again, and the Try again started a window flow whose view showed
    expect([failed, page.shown.filter(shown => shown.view === 'connecting')]).toMatchObject([
      { view: 'site-failed', retry: true },
      [{ view: 'connecting', pageHost: ORIGIN }],
    ]);
  });

  it("As a dotli integrator, I dispose a site's sign-in window as it opens and it shows none of its round's views after it", async () => {
    // Given a site's sign-in window that has just opened
    const page = openSignInWindow();

    // When it is disposed and the round then reaches its consent view
    page.dispose();
    await waitForStatus(page.site.screen, current => current.view === 'consent');

    // Then the window still shows only what it showed as it opened
    expect(page.shown).toEqual([{ view: 'site-signing', route: 'auth' }]);
  });

  it('As a dotli integrator, I dispose a site window after a Try again and neither window flow shows a pairing after it, while its responder still takes a payload', async () => {
    // Given a window whose stored session was gone, so Try again started a second window flow, and whose round ended
    let reads = 0;
    const page = openSignInWindow({
      mainAccount: () => {
        reads += 1;
        return reads === 1
          ? Promise.reject(new MainAccountError('signed_out', 'The main session ended'))
          : Promise.resolve(MAIN);
      },
    });
    await page.waitForView('consent');
    await page.site.consent();
    await page.waitForView('site-failed');
    await page.site.retry();
    await page.closed;
    const changes = page.flows.map(flow => {
      const seen: unknown[] = [];
      onTestFinished(
        flow.screen.listen(() => {
          seen.push(flow.screen.get());
        }),
      );
      return seen;
    });

    // When the window is disposed, then the core starts pairing and the site posts a payload
    page.dispose();
    page.auth.set(PAIRING);
    page.postPayload(CALL);
    const payload = await Promise.race([page.params.responder.payload(), Promise.resolve('unsettled')]);

    // Then neither flow changed its screen, since each was disposed, and the responder the window does not own took the
    // payload
    expect(page.flows).toHaveLength(2);
    expect(changes).toEqual([[], []]);
    expect(payload).toBe(CALL);
  });

  it('As a dotli integrator, I dispose a site window whose stored session is gone and Try again on its round starts no window flow after it', async () => {
    // Given a window whose stored session was gone after its first window flow, so its round offers Try again
    const page = openSignInWindow({
      mainAccount: () => Promise.reject(new MainAccountError('signed_out', 'The main session ended')),
    });
    await page.waitForView('consent');
    await page.site.consent();
    await page.waitForView('site-failed');
    const shown = [...page.shown];

    // When the window is disposed, then the user presses Try again and the core starts pairing
    page.dispose();
    await page.site.retry();
    page.auth.set(PAIRING);

    // Then no second window flow started, and the window shows nothing more
    expect(page.flows).toHaveLength(1);
    expect(page.shown).toEqual(shown);
  });

  it('As a dotli integrator, I dispose a site window whose window flow keeps running and the window listens to its screen no more', async () => {
    // Given a window that started a window flow on its consent, whose own dispose does nothing and whose session read
    // is held
    const read = createDeferred<undefined>();
    const page = openSignInWindow({ leaveFlowsRunning: true, sessionReadHeld: read.promise });
    await page.waitForView('consent');
    const consenting = page.site.consent();
    await page.waitForView('connecting');
    const whileOpen = page.countFlowScreenListeners();

    // When the window is disposed, and the flow's session read then settles
    page.dispose();
    read.resolve(undefined);
    await consenting;

    // Then the window followed the flow while it was open, and listens to its screen no more
    expect(whileOpen).toBe(1);
    expect(page.countFlowScreenListeners()).toBe(0);
  });

  it("As a dotli integrator, I dispose a site's window twice and see no error", () => {
    // Given a site's sign-in window disposed once
    const page = openSignInWindow();
    page.dispose();

    // When it is disposed again
    const thrown = catchError(() => {
      page.dispose();
    });

    // Then nothing threw
    expect(thrown).toBeUndefined();
  });
});

describe('site window screen chain', () => {
  it("As the site window, I read the current flow's latest screen at once through the chain, and keep it while the flow screen is null", async () => {
    // Given a window flow that shows a connecting screen, whose earlier listener moves a pairing on to a failed one, and
    // a core that reports the stored session gone, so a Try again starts a second flow
    const connecting: SignInScreen = {
      view: 'connecting',
      pageHost: ORIGIN,
      failure: null,
      pairing: { kind: 'spinner' },
    };
    const pairing: SignInScreen = { view: 'pairing', pageHost: ORIGIN, failure: null, pairing: { kind: 'spinner' } };
    const failed: SignInScreen = { view: 'failed', pageHost: ORIGIN, failure: 'step', pairing: { kind: 'spinner' } };
    const flowScreen = atom<SignInScreen>(connecting);
    onTestFinished(
      flowScreen.listen(current => {
        if (current.view === 'pairing') {
          flowScreen.set(failed);
        }
      }),
    );
    const never = new Promise<void>(() => undefined);
    const page = openSignInWindow({
      flowScreen,
      sessionReadHeld: never,
      mainAccount: () => Promise.reject(new MainAccountError('signed_out', 'The main session ended')),
    });
    const delivered = { session: { blob: MAIN_BLOB, uiState: MAIN_UI_STATE }, localWallet: null };
    await page.waitForView('consent');
    await page.site.consent();
    must(page.deliveries[0], 'the first delivery')(delivered);
    await page.waitForView('site-failed');
    await page.site.retry();

    // When the second flow shows a pairing
    flowScreen.set(pairing);
    const shownWithFlow = page.screen.get();
    // And the first flow stores its sign-in late, which empties the flow screen while the site's round ignores it
    must(page.deliveries[0], 'the first delivery')(delivered);
    const shownAfterDelivery = page.screen.get();

    // Then the window shows the flow's latest screen, and keeps it while the flow screen is null
    expect(shownWithFlow).toEqual(failed);
    expect(shownAfterDelivery).toEqual(failed);
  });
});

describe('site transaction window', () => {
  it("As a user, I open a site's transaction and see it go from Signing to its consent for the site I opened the window from", async () => {
    // Given a site's request that carries its call and a token whose grant is still being read
    const grantRead = createDeferred<undefined>();
    const page = openTransactionWindow(CALL, { grantRead: grantRead.promise });
    const watched = watchWindow(must(await page.opening, 'an opened transaction window'));

    // When the grant read ends
    grantRead.resolve(undefined);
    await watched.waitForView('consent');

    // Then the window started on the sign route's working view, then asked the consent of the vetted origin
    expect(watched.shown).toEqual([{ view: 'site-signing', route: 'sign' }, { view: 'consent' }]);
    expect(watched.screen.get()).toMatchObject({ origin: ORIGIN });
  });

  it('As a site, I send a call in my request and a payload and get my transaction signed for the call my request carries', async () => {
    // Given a site's request that carries its call, and a payload with another call the site posted as well
    const page = openTransactionWindow(CALL);
    page.postPayload(PAYLOAD_CALL);
    const watched = watchWindow(must(await page.opening, 'an opened transaction window'));
    await watched.waitForView('consent');

    // When the user consents and confirms the review
    await watched.site.consent();
    await watched.waitForView('site-review');
    watched.site.confirm();
    await page.closed;

    // Then the request's call was decoded, and the site got the signed transaction
    expect(page.decoded).toEqual([CALL]);
    expect(page.readPosted()).toContainEqual({
      type: 'dotli:s:result',
      round: 'r1',
      result: { transaction: SIGNED_TX },
      site_token: TOKEN,
    });
  });

  it('As a site, I post my call after the window opened and the window waits for it before it starts my round', async () => {
    // Given a site's request with no call, whose window asked for the payload
    const page = openTransactionWindow(null);
    await page.asked;

    // When the site posts its call
    page.postPayload(PAYLOAD_CALL);
    const watched = watchWindow(must(await page.opening, 'an opened transaction window'));
    await watched.waitForView('consent');
    await watched.site.consent();
    await watched.waitForView('site-review');

    // Then the round started with the call that came, and decodes the posted call
    expect(page.decoded).toEqual([PAYLOAD_CALL]);
  });

  it('As a site, I post a call that is not hex of two or more bytes and am refused as a bad request, counted as my transaction', async () => {
    // Given a site's request with no call, whose window asked for the payload
    const page = openTransactionWindow(null);
    await page.asked;

    // When the site posts a one-byte call
    page.postPayload('0x0a');
    const opened = await page.opening;
    await page.closed;

    // Then no round starts, the site is refused and the refusal counts as a transaction
    expect(opened).toBeNull();
    expect(page.decoded).toEqual([]);
    expect(page.readPosted()).toContainEqual({ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' });
    expect(page.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'bad_request' },
    ]);
  });
});
