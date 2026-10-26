// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { hex } from '@scure/base';
import { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } from '@dotli/config';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createSyncStore, deferred, fromHex, storeStatus, toHex, untilStatus } from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore } from '@dotli/storage';
import { memorySiteGrantsIdb } from '@dotli/storage/testing';
import type { AuthCommands } from '../core-login.js';
import { createFakeMessageBus, createFakeWindowHandle } from '../session-handoff/messages.fake.js';
import { openerParty } from '../session-handoff/opener-rule.js';
import { createResponder } from '../session-handoff/responder.js';
import { createWindowFlow } from '../session-handoff/window-flow.js';
import type { DotliAuthState } from '../session/auth-state.js';
import { createFakeSessionPresence } from '../session/presence.fake.js';
import { ownerSignInFlag } from '../session/sign-in-flag.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import { parsePublicSuffixList } from './public-suffix-list.js';
import { encodeSs58 } from './site-assertion.js';
import type { DisplayCall } from './site-call.js';
import type { SiteChain, SiteSubmitEvent } from './site-chain.js';
import type { SiteSignRequest } from './site-sign-request.js';
import type { SiteSigner } from './site-signer.js';
import { openSiteSignIn, openSiteTransaction, type SiteWindow, type SiteWindowDeps } from './site-window.js';

const SELF = 'https://dot.li';
const ORIGIN = 'https://my-site.com';
const NET = NetworkName.PASEO;
const NETWORK = NETWORK_NAME_TO_SERVICES_CONFIG[NET];
const NOW = Date.parse('2026-10-23T15:00:00.000Z');

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const MAIN_UI_STATE = JSON.stringify({ connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot' });
const MAIN_BLOB = 'MAIN-SESSION-BLOB';
const WALLET_ENTROPY = new Uint8Array(16).fill(0x5c);
const WALLET_ACCOUNT = '5LocalWalletIdentityAccountOfTheMainStore';

const SITE_KEY = new Uint8Array(32).fill(0x22);
const SIGNATURE = `0x${'11'.repeat(64)}`;
const TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
/** A token the site kept from an earlier round, which names no grant this store keeps. */
const OLD_TOKEN = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';

const CONNECTED: DotliAuthState = { tag: 'Connected', session: { connected: true, publicKey: MAIN_KEY } };

const CALL = '0x0a0300010203';
const PAYLOAD_CALL = '0x0a0300040506';
const DISPLAY: DisplayCall = { name: 'Balances.transfer_keep_alive', args: [{ name: 'value', value: '1' }] };
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

/**
 * A session window over fakes for a site's round: the opener and its messages, a main store that holds a paired
 * session and a local wallet, the window's auth state, an in-memory grants store and a signer that signs at once, with
 * the window's real responder and real window flow. The site said hello, so the window is vetted.
 */
function windowParts() {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  recordLog({ onFinished: onTestFinished, level: 'error' });
  const opener = createFakeWindowHandle();
  const messages = createFakeMessageBus();
  const responder = createResponder<unknown>({
    opener,
    judge: origin => openerParty(origin, SELF),
    round: 'r1',
    listen: messages.listen,
    onPageRestore: createFakePageEvents().subscribe,
  });
  messages.post({ data: { type: 'dotli:s:hello', v: 1, round: 'r1' }, origin: ORIGIN, source: opener });
  const signIns = ownerSignInFlag({
    presence: createFakeSessionPresence('present'),
    storedSignIn: () => Promise.resolve('held'),
  });
  // The window resumes what is stored, so it never pairs or signs out.
  const commands: AuthCommands = {
    login: () => Promise.reject(new Error('The window paired')),
    logout: () => Promise.reject(new Error('The window signed out')),
    cancelLogin: () => undefined,
  };
  const signer: SiteSigner = {
    sign: (_origin, text) => {
      text(SITE_KEY);
      return Promise.resolve({ publicKey: SITE_KEY, signature: SIGNATURE });
    },
    account: () => Promise.resolve(SITE_KEY),
  };
  const closed = deferred<undefined>();
  const deps: Omit<SiteWindowDeps, 'request'> = {
    origin: ORIGIN,
    self: SELF,
    net: NET,
    responder,
    createWindowFlow: flow =>
      createWindowFlow({
        signIns,
        auth: createSyncStore<DotliAuthState>('testSiteWindowAuth', CONNECTED),
        commands,
        store: {
          readSession: () => Promise.resolve({ status: 'ok', blob: MAIN_BLOB }),
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
      }),
    grants: createSiteGrantStore(memorySiteGrantsIdb()),
    groups: {
      registrable: () => Promise.reject(new Error('The window loaded the suffix list for a site of no group')),
    },
    signer,
    auth: createSyncStore<DotliAuthState>('testSiteAuth', CONNECTED),
    readUiCache: () => Promise.resolve(MAIN_UI_STATE),
    now: () => NOW,
    randomToken: () => TOKEN,
    close: () => {
      closed.resolve(undefined);
    },
  };
  return {
    deps,
    metrics,
    closed: closed.promise,
    /** Every message the opener got, ready included. */
    posted: () => opener.posted.map(({ message }) => message),
    /** The site posts `call` as the round's payload. */
    payload: (call: string): void => {
      messages.post({ data: { type: 'dotli:s:payload', round: 'r1', call }, origin: ORIGIN, source: opener });
    },
  };
}

/** What the window showed of `window`, each view with the page or route it names, from now on. */
function watchWindow({ site, screen }: SiteWindow) {
  const shown: { view: string; pageHost?: string | null; route?: string }[] = [];
  const record = (): void => {
    const current = screen.get();
    if ('pageHost' in current) {
      shown.push({ view: current.view, pageHost: current.pageHost });
    } else if ('route' in current) {
      shown.push({ view: current.view, route: current.route });
    } else {
      shown.push({ view: current.view });
    }
  };
  record();
  screen.subscribe(record);
  return {
    site,
    screen,
    shown,
    /** Resolves once the window shows `view`. */
    until: (view: string) => untilStatus(storeStatus(screen), current => current.view === view),
  };
}

/** A site's sign-in in a session window over the window's parts. */
function harness() {
  const parts = windowParts();
  const window = openSiteSignIn({
    ...parts.deps,
    request: { round: 'r1', nonce: '8f2c1a9e0b7d4e6f', statement: null, siteToken: null, groupToken: null },
  });
  return { ...parts, ...watchWindow(window) };
}

/** Asset Hub that decodes any call and includes its transaction, recording each call it decodes as hex. */
function fakeChain() {
  const decoded: string[] = [];
  const events: SiteSubmitEvent[] = [
    { kind: 'submitted', txHash: TX_HASH },
    { kind: 'included', txHash: TX_HASH, blockHash: BLOCK_HASH, ok: true },
  ];
  const chain: SiteChain = {
    open: () =>
      Promise.resolve({
        decode: call => {
          decoded.push(toHex(call));
          return Promise.resolve({
            display: DISPLAY,
            transaction: {
              createSubmitAndWatch: () => {
                throw new Error('The fake chain submits through its session');
              },
            },
          });
        },
        submit: () => {
          const queue = [...events];
          return {
            [Symbol.asyncIterator]: () => ({
              next: (): Promise<IteratorResult<SiteSubmitEvent>> => {
                const event = queue.shift();
                return Promise.resolve(
                  event === undefined ? { done: true, value: undefined } : { done: false, value: event },
                );
              },
            }),
          };
        },
        close: () => undefined,
      }),
  };
  return { chain, decoded };
}

/**
 * A site's transaction window over the window's parts and a chain that includes it, for a request that carries
 * `call` or leaves it to a payload. `asked` resolves once the window asked for the payload. With `grantRead`, the
 * request carries an old token whose read waits for it. `submitted` names the rounds the tab already submitted.
 */
function transactionHarness(
  call: string | null,
  { grantRead, submitted = [] }: { grantRead?: Promise<void>; submitted?: string[] } = {},
) {
  const parts = windowParts();
  const { chain, decoded } = fakeChain();
  const asked = deferred<undefined>();
  const request: SiteSignRequest = {
    round: 'r1',
    siteToken: grantRead === undefined ? null : OLD_TOKEN,
    groupToken: null,
    chain: NETWORK.assethub.genesis,
    call,
  };
  const { responder, grants } = parts.deps;
  const marked = new Set(submitted);
  const opening = openSiteTransaction({
    ...parts.deps,
    request,
    grants: {
      ...grants,
      read: async token => {
        await grantRead;
        return grants.read(token);
      },
    },
    responder: {
      ...responder,
      payload: () => {
        asked.resolve(undefined);
        return responder.payload();
      },
    },
    chain,
    txSigner: { creator: () => () => Promise.reject(new Error('The fake chain builds no transaction')) },
    submitted: {
      has: round => marked.has(round),
      mark: round => {
        marked.add(round);
      },
    },
  });
  return { ...parts, decoded, asked: asked.promise, opening };
}

describe('site sign-in window', () => {
  it('As a user, I never hand a site my main session, main account or local wallet', async () => {
    // Given a main store with a paired session and a local wallet beside it, and a site on its consent view
    const h = harness();
    await h.until('consent');

    // When the user consents and the round runs to its result
    await h.site.consent();
    await h.closed;

    // Then the site got its result, and no message it got carries any of them
    // A byte array writes as its hex, since JSON would write it as an object of indices.
    const sent = h
      .posted()
      .map(message =>
        JSON.stringify(message, (_key, value: unknown) => (value instanceof Uint8Array ? toHex(value) : value)),
      );
    const secrets = [
      MAIN_BLOB,
      'a'.repeat(64),
      encodeSs58(fromHex(MAIN_KEY), NETWORK.ss58Prefix),
      hex.encode(WALLET_ENTROPY),
      WALLET_ACCOUNT,
    ];
    expect(sent.filter(message => message.includes('dotli:s:result'))).toHaveLength(1);
    expect(sent.join('\n')).toContain(toHex(SITE_KEY));
    for (const message of sent) {
      for (const secret of secrets) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it("As a user, I see the site's consent, then the window flow's view naming the site by its full origin, then the signing", async () => {
    // Given a site on its consent view
    const h = harness();
    await h.until('consent');

    // When the user consents and the round runs to its result
    await h.site.consent();
    await h.closed;

    // Then the window showed the site's views, and the window flow's own while it resumed the main session
    expect(h.shown).toEqual([
      { view: 'site-signing', route: 'auth' },
      { view: 'consent' },
      { view: 'connecting', pageHost: ORIGIN },
      { view: 'site-signing', route: 'auth' },
    ]);
  });
});

describe('site group window', () => {
  it("As a user, I see a group's consent name the registrable domain of the site I opened the window from", async () => {
    // Given the window's parts with a suffix list that loads
    const parts = windowParts();
    const suffixes = parsePublicSuffixList('com\nli\n');

    // When a site asks to sign in under a group token
    const w = watchWindow(
      openSiteSignIn({
        ...parts.deps,
        groups: { registrable: hostname => Promise.resolve(suffixes.registrable(hostname)) },
        request: { round: 'r1', nonce: '8f2c1a9e0b7d4e6f', statement: null, siteToken: null, groupToken: 'my group' },
      }),
    );
    await w.until('consent');

    // Then the consent names the site's origin and its group's registrable domain
    expect(w.screen.get()).toEqual({ view: 'consent', origin: ORIGIN, statement: null, group: 'my-site.com' });
  });
});

describe('site transaction window', () => {
  it("As a user, I see a site's transaction from Signing to its consent for the site I opened the window from", async () => {
    // Given a site's request that carries its call and a token whose grant is still being read
    const grantRead = deferred<undefined>();
    const h = transactionHarness(CALL, { grantRead: grantRead.promise });
    const w = watchWindow(must(await h.opening, 'an opened transaction window'));

    // When the grant read ends
    grantRead.resolve(undefined);
    await w.until('consent');

    // Then the window started on the sign route's working view, then asked the consent of the vetted origin
    expect(w.shown).toEqual([{ view: 'site-signing', route: 'sign' }, { view: 'consent' }]);
    expect(w.screen.get()).toMatchObject({ origin: ORIGIN });
  });

  it("As a site, I get my transaction's result for the call my request carries, ignoring any payload", async () => {
    // Given a site's request that carries its call, and a payload with another call the site posted as well
    const h = transactionHarness(CALL);
    h.payload(PAYLOAD_CALL);
    const w = watchWindow(must(await h.opening, 'an opened transaction window'));
    await w.until('consent');

    // When the user consents and confirms the review
    await w.site.consent();
    await w.until('site-review');
    w.site.confirm();
    await h.closed;

    // Then the request's call was decoded, and the site got the transaction's result
    expect(h.decoded).toEqual([CALL]);
    expect(h.posted()).toContainEqual({
      type: 'dotli:s:result',
      round: 'r1',
      result: { tx_hash: TX_HASH, status: 'included', block_hash: BLOCK_HASH },
      site_token: TOKEN,
    });
  });

  it('As a site, I post my call after the window opened and the window waits for it before it starts my round', async () => {
    // Given a site's request with no call, whose window asked for the payload
    const h = transactionHarness(null);
    await h.asked;

    // When the site posts its call
    h.payload(PAYLOAD_CALL);
    const w = watchWindow(must(await h.opening, 'an opened transaction window'));
    await w.until('consent');
    await w.site.consent();
    await w.until('site-review');

    // Then the round started with the call that came, and decodes the posted call
    expect(h.decoded).toEqual([PAYLOAD_CALL]);
  });

  it('As a site, I post a call that is not hex of two or more bytes and am refused as a bad request, counted as my transaction', async () => {
    // Given a site's request with no call, whose window asked for the payload
    const h = transactionHarness(null);
    await h.asked;

    // When the site posts a one-byte call
    h.payload('0x0a');
    const window = await h.opening;
    await h.closed;

    // Then no round starts, the site is refused and the refusal counts as a transaction
    expect(window).toBeNull();
    expect(h.decoded).toEqual([]);
    expect(h.posted()).toContainEqual({ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'bad_request' },
    ]);
  });

  it('As a site whose window reloaded after it submitted my transaction, I am refused with transaction_unknown before my call or any consent', async () => {
    // Given a reloaded window whose tab submitted this round's transaction, for a request with no call
    const h = transactionHarness(null, { submitted: ['r1'] });

    // When the window opens the round
    const window = await h.opening;
    await h.closed;

    // Then no round starts, nothing was decoded, and the site is refused as unknown, counted as its transaction
    expect(window).toBeNull();
    expect(h.decoded).toEqual([]);
    expect(h.posted()).toContainEqual({ type: 'dotli:s:refused', round: 'r1', reason: 'transaction_unknown' });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'transaction_unknown' },
    ]);
  });
});
