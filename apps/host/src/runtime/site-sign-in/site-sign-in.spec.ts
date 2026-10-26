// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProductAccountId } from '@parity/truapi';
import { describe, expect, it, onTestFinished } from 'vitest';
import { base64urlnopad } from '@scure/base';
import { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } from '@dotli/config';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import {
  blake2b,
  createSyncStore,
  deferred,
  fromHex,
  storeStatus,
  toHex,
  untilStatus,
  type ReadableStore,
} from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrant, type SiteGrantStore } from '@dotli/storage';
import { memorySiteGrantsIdb } from '@dotli/storage/testing';
import type { ResponderState } from '../session-handoff/responder.js';
import type { MainAccount } from './main-account.js';
import { encodeSs58, formatSiteAssertion } from './site-assertion.js';
import type { SiteRequest } from './site-request.js';
import type { SiteSignInResult } from './site-result.js';
import { SiteRoundRefusal, SiteRoundRejected, type SiteRound, type SiteScreen } from './site-round.js';
import { createSiteSignIn, siteSignInAction, type SiteSignInDeps } from './site-sign-in.js';
import { SiteSignError, SiteSignRejectedError, type SiteSigner } from './site-signer.js';
import { parsePublicSuffixList } from './public-suffix-list.js';
import type { SiteGroups } from './site-groups.js';

const ORIGIN = 'https://my-site.com';
const NET = NetworkName.PASEO;
const NETWORK = NETWORK_NAME_TO_SERVICES_CONFIG[NET];
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: `myapp.${NETWORK.dotns.TLD}`,
  derivationIndex: { tag: 'Index', value: 0 },
};
const NOW = Date.parse('2026-10-23T15:00:00.000Z');
const NONCE = '8f2c1a9e0b7d4e6f';
const STATEMENT = 'Optional statement from the site.';

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(blake2b(fromHex(MAIN_KEY), 32));

const SITE_KEY = new Uint8Array(32).fill(0x22);
const SIGNATURE = `0x${'11'.repeat(64)}`;

const TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(1));
const NEW_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(2));

/** The main account the window's core reports. */
const MAIN: MainAccount = { owner: OWNER, username: { name: 'alice.dot', kind: 'full' } };

const REQUEST: SiteRequest = {
  round: 'r1',
  nonce: NONCE,
  account: ACCOUNT,
  statement: STATEMENT,
  siteToken: null,
  groupToken: null,
};

/** The registrable domains of a few rules of the Public Suffix List, as the window's loaded list gives them. */
const SUFFIXES = parsePublicSuffixList('com\nli\n');
const GROUPS: SiteGroups = { registrable: hostname => Promise.resolve(SUFFIXES.registrable(hostname)) };

function grantOf(fields: Partial<SiteGrant> = {}): SiteGrant {
  return {
    token: TOKEN,
    origin: ORIGIN,
    owner: OWNER,
    firstUsedAt: NOW - 1000,
    lastUsedAt: NOW - 1000,
    ...fields,
  };
}

/** One message the window posted to its opener. */
type Post =
  | { type: 'dotli:s:result'; result: SiteSignInResult; site_token?: string }
  | { type: 'dotli:s:refused'; reason: string }
  | { type: 'dotli:s:cancelled' };

interface HarnessOptions {
  /** The site's origin, {@link ORIGIN} by default. */
  origin?: string;
  /** The account the site names, {@link ACCOUNT} by default. */
  account?: ProductAccountId;
  siteToken?: string | null;
  groupToken?: string | null;
  /** A grants store another round shares, in place of a new one. */
  store?: SiteGrantStore;
  /** Grants the main store keeps before the round. */
  grants?: SiteGrant[];
  /** Failures the signer answers with, one per call, before it signs. */
  signFailures?: Error[];
  /** The signature the signer answers with. */
  signature?: string;
  /** The public key the signer reads for any account, {@link SITE_KEY} by default. */
  publicKey?: Uint8Array;
  /** Whether saving a grant fails. */
  saveFails?: boolean;
  /** The main account the window's core reports, {@link MAIN} by default. */
  main?: MainAccount;
}

/** A signer that signs at once, recording each text it signed, after it answers with each failure it was given. */
function fakeSigner(options: Pick<HarnessOptions, 'signFailures' | 'signature' | 'publicKey'>) {
  const signFailures = [...(options.signFailures ?? [])];
  const signs: { account: ProductAccountId; text: string }[] = [];
  const signer: SiteSigner = {
    sign: (account, text) => {
      const failure = signFailures.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const publicKey = options.publicKey ?? SITE_KEY;
      signs.push({ account, text: text(publicKey) });
      return Promise.resolve({ publicKey, signature: options.signature ?? SIGNATURE });
    },
    account: () => Promise.reject(new Error('The sign-in read the account apart from its signature')),
  };
  return { signer, signs };
}

/**
 * A site's sign-in over fakes: a responder that records what it posts and ends its round on its first terminal call, an
 * in-memory grants store, a signer that signs at once, the main account the window's core reports, and a window flow
 * the test says stored a sign-in through.
 */
async function harness(options: HarnessOptions = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const origin = options.origin ?? ORIGIN;
  const posts: Post[] = [];
  const round = createSyncStore<ResponderState>('testSiteResponder', { kind: 'vetted', origin, party: 'third' });
  const end = (post: Post, state: ResponderState): void => {
    const { kind } = round.get();
    if (kind === 'answered' || kind === 'refused') {
      return;
    }
    posts.push(post);
    round.set(state);
  };
  const responder: SiteSignInDeps['responder'] = {
    state: round.get,
    subscribe: listener =>
      round.subscribe(() => {
        listener(round.get());
      }),
    send: (result, siteToken) => {
      end(
        {
          type: 'dotli:s:result',
          result,
          ...(siteToken === undefined ? {} : { site_token: siteToken }),
        },
        { kind: 'answered' },
      );
    },
    refuse: reason => {
      end({ type: 'dotli:s:refused', reason }, { kind: 'refused' });
    },
    cancel: () => {
      end({ type: 'dotli:s:cancelled' }, { kind: 'answered' });
    },
  };
  const stored = options.store ?? createSiteGrantStore(memorySiteGrantsIdb());
  for (const grant of options.grants ?? []) {
    await stored.save(grant);
  }
  const grants: SiteGrantStore = {
    ...stored,
    save: async grant => {
      if (options.saveFails === true) {
        throw new Error('The grants database is full');
      }
      await stored.save(grant);
    },
  };
  const { signer, signs } = fakeSigner(options);
  const windowFlows: { stored: () => void; close: () => void }[] = [];
  const closed = deferred<undefined>();
  const flow = createSiteSignIn({
    request: {
      ...REQUEST,
      account: options.account ?? ACCOUNT,
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
    },
    origin,
    self: 'https://dot.li',
    net: NET,
    responder,
    grants,
    groups: GROUPS,
    signer,
    mainAccount: () => Promise.resolve(options.main ?? MAIN),
    startWindowFlow: (stored, close) => {
      windowFlows.push({ stored, close });
    },
    now: () => NOW,
    randomToken: () => NEW_TOKEN,
    close: () => {
      closed.resolve(undefined);
    },
  });
  const views: SiteScreen['view'][] = [flow.screen.get().view];
  flow.screen.subscribe(() => {
    views.push(flow.screen.get().view);
  });
  return {
    flow,
    posts,
    stored,
    signs,
    views,
    metrics,
    errors,
    closed: closed.promise,
    /** The window flow the site flow started, which the test says stored a sign-in through. */
    windowFlow: () => must(windowFlows[0], 'a started window flow'),
    /** Resolves once the screen shows `view`. */
    until: (view: SiteScreen['view']) => untilView(flow.screen, view),
  };
}

function untilView(screen: ReadableStore<SiteScreen>, view: SiteScreen['view']): Promise<void> {
  return untilStatus(storeStatus(screen), shown => shown.view === view);
}

function resultOf(posts: Post[]): Extract<Post, { type: 'dotli:s:result' }> {
  const [post] = posts;
  if (post?.type !== 'dotli:s:result') {
    throw new Error(`Expected one result, got ${JSON.stringify(posts)}`);
  }
  return post;
}

/** Consents on the consent view, and the window flow says a sign-in is stored. */
async function consentAndStore(flow: SiteRound, h: Awaited<ReturnType<typeof harness>>) {
  await h.until('consent');
  await flow.consent();
  h.windowFlow().stored();
}

describe('site sign-in', () => {
  it('As a user signing in to a new site, I consent and the site gets my site account, its assertion and a token', async () => {
    // Given a site the main store keeps no grant for
    const h = await harness();

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site gets the assertion of its request's fields, signed by its own account, and a new token it keeps
    const address = encodeSs58(SITE_KEY, NETWORK.ss58Prefix);
    const post = resultOf(h.posts);
    expect(post.result).toEqual({
      username: { name: 'alice.dot', kind: 'full' },
      address,
      public_key: toHex(SITE_KEY),
      assertion: {
        message: formatSiteAssertion({
          origin: ORIGIN,
          address,
          statement: STATEMENT,
          relayGenesis: NETWORK.relay.genesis,
          nonce: NONCE,
          issuedAt: NOW,
          username: { name: 'alice.dot', kind: 'full' },
          group: null,
        }),
        signature: SIGNATURE,
      },
    });
    expect(post.site_token).toBe(NEW_TOKEN);
    expect(h.signs).toEqual([{ account: ACCOUNT, text: post.result.assertion.message }]);
    expect(await h.stored.list()).toEqual([
      { token: NEW_TOKEN, origin: ORIGIN, owner: OWNER, firstUsedAt: NOW, lastUsedAt: NOW },
    ]);
    expect(h.views).toEqual(['site-signing', 'consent', 'window', 'site-signing']);
    expect(h.flow.screen.get()).toEqual({ view: 'site-signing', origin: ORIGIN, route: 'auth' });
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'new' }]);
  });

  it("As a site, my sign-in proof is signed by the account I named and its address is that account's", async () => {
    // Given a site that names an account by a raw index, whose key the signer reads
    const account: ProductAccountId = {
      dotNsIdentifier: `myapp.${NETWORK.dotns.TLD}`,
      derivationIndex: { tag: 'Raw', value: `0x${'7'.repeat(64)}` },
    };
    const accountKey = new Uint8Array(32).fill(0x44);
    const h = await harness({ account, publicKey: accountKey });

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the signer signed with that account, and the site got that account's key and address
    const { result } = resultOf(h.posts);
    expect(h.signs.map(sign => sign.account)).toEqual([account]);
    expect(result.address).toBe(encodeSs58(accountKey, NETWORK.ss58Prefix));
    expect(result.public_key).toBe(toHex(accountKey));
  });

  it('As a user signing in to a site I signed in to before, I skip consent and the site keeps its token', async () => {
    // Given a grant for this site and this main account
    const h = await harness({ siteToken: TOKEN, grants: [grantOf()] });

    // When the window flow says a sign-in is stored
    await h.until('window');
    h.windowFlow().stored();
    await h.closed;

    // Then no consent showed, the named account signed, the site got no new token and the grant's last use moved on
    expect(h.views).not.toContain('consent');
    expect(h.signs.map(sign => sign.account)).toEqual([ACCOUNT]);
    const post = resultOf(h.posts);
    expect(post.site_token).toBeUndefined();
    expect(post.result.public_key).toBe(toHex(SITE_KEY));
    expect(await h.stored.list()).toEqual([grantOf({ lastUsedAt: NOW })]);
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'known' }]);
  });

  it('As a user with no username, I refuse the site with no_username', async () => {
    // Given a main account with no username
    const h = await harness({ main: { owner: OWNER, username: null } });

    // When the round reads it
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site is refused for the username and nothing was signed
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'no_username' }]);
    expect(h.signs).toEqual([]);
  });

  it('As a user with only a lite username, I sign in to the site with it', async () => {
    // Given a main account with only a lite username
    const h = await harness({ main: { owner: OWNER, username: { name: 'alice.01', kind: 'lite' } } });

    // When the round reads it
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site gets the lite username
    expect(resultOf(h.posts).result.username).toEqual({ name: 'alice.01', kind: 'lite' });
  });

  it('As a user who rejects the request on the phone, I cancel the round and keep no grant', async () => {
    // Given a signer that the user rejects on the phone
    const h = await harness({
      signFailures: [
        new SiteSignRejectedError('sign', { tag: 'Domain', value: { tag: 'V1', value: { tag: 'Rejected' } } }),
      ],
    });

    // When the round reaches the signature
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site hears the round was cancelled and nothing was kept
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(await h.stored.list()).toEqual([]);
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'cancelled', reason: 'phone' }]);
  });

  it('As a user whose signature failed, I retry and the site gets its result', async () => {
    // Given a signer that fails once
    const h = await harness({ signFailures: [new SiteSignError('sign', { tag: 'Denied' })] });
    await consentAndStore(h.flow, h);
    await h.until('site-failed');
    const failed = { posts: [...h.posts], errors: h.errors.length };

    // When the user retries
    await h.flow.retry();
    await h.closed;

    // Then the failure showed with nothing sent, and the retry sent the result
    expect(failed).toEqual({ posts: [], errors: 1 });
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([
      { outcome: 'error', reason: 'sign' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });

  it('As a user whose site account could not be read, I see the failure counted for the account', async () => {
    // Given a signer whose account read fails
    const h = await harness({ signFailures: [new SiteSignError('account', { tag: 'Denied' })] });

    // When the round reaches the signature
    await consentAndStore(h.flow, h);
    await h.until('site-failed');

    // Then the failure names the account and nothing was sent
    expect(h.posts).toEqual([]);
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'error', reason: 'account' }]);
  });

  it('As a site, I get the signature as lowercase hex', async () => {
    // Given a signer that answers in uppercase hex
    const h = await harness({ signature: `0x${'AB'.repeat(64)}` });

    // When the round runs
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the result carries the lowercase signature
    expect(resultOf(h.posts).result.assertion.signature).toBe(`0x${'ab'.repeat(64)}`);
  });

  it('As a user whose signature is not 64 bytes, I see the signature failed and the site gets nothing', async () => {
    // Given a signer that answers with a short signature
    const h = await harness({ signature: `0x${'11'.repeat(63)}` });

    // When the round runs
    await consentAndStore(h.flow, h);
    await h.until('site-failed');

    // Then nothing was sent or kept
    expect(h.posts).toEqual([]);
    expect(await h.stored.list()).toEqual([]);
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'error', reason: 'sign' }]);
  });

  it('As a site whose grant cannot be saved, I still get my result without a token and the failure is counted', async () => {
    // Given a grants store that cannot save
    const h = await harness({ saveFails: true });

    // When the round runs
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site got its result with no token, nothing was kept, and the failed save was reported and counted
    const post = resultOf(h.posts);
    expect(post.result.public_key).toBe(toHex(SITE_KEY));
    expect(post.site_token).toBeUndefined();
    expect(await h.stored.list()).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.views).not.toContain('site-failed');
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([
      { outcome: 'error', reason: 'grant' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });

  it('As a user whose phone cannot be reached, I see the signature failed and can try again', async () => {
    // Given a signer that fails with the core's own error, as when no connection could be made
    const h = await harness({ signFailures: [new Error('The core refused the connection')] });

    // When the round reaches the signature
    await consentAndStore(h.flow, h);
    await h.until('site-failed');

    // Then the failure names the signature and offers Try again
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'auth', retry: true });
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'error', reason: 'sign' }]);
  });
});

describe('site sign-in action', () => {
  it('As a site, I am refused with no_username for a main account without a username, before anything is signed', async () => {
    // Given the sign-in action and a main account with no username
    const { signer, signs } = fakeSigner({});
    const action = siteSignInAction({ origin: ORIGIN, request: REQUEST, net: NET, signer, now: () => NOW });
    const controller = new AbortController();

    // When the action runs for it
    const refusal: unknown = await action
      .run({
        main: { owner: OWNER, username: null },
        account: ACCOUNT,
        show: () => undefined,
        confirmed: () => Promise.resolve(),
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught);

    // Then it refuses the site with no_username, and nothing was signed
    expect(refusal).toBeInstanceOf(SiteRoundRefusal);
    expect(refusal).toMatchObject({ reason: 'no_username' });
    expect(signs).toEqual([]);
  });

  it('As a user who rejects the signature on the phone, I end the sign-in with a rejection the round reads', async () => {
    // Given the sign-in action over a signer the user rejects on the phone
    const rejection = new SiteSignRejectedError('sign', {
      tag: 'Domain',
      value: { tag: 'V1', value: { tag: 'Rejected' } },
    });
    const { signer } = fakeSigner({ signFailures: [rejection] });
    const action = siteSignInAction({ origin: ORIGIN, request: REQUEST, net: NET, signer, now: () => NOW });
    const controller = new AbortController();

    // When the action runs for the main account
    const rejected: unknown = await action
      .run({
        main: MAIN,
        account: ACCOUNT,
        show: () => undefined,
        confirmed: () => Promise.resolve(),
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught);

    // Then it rejects with the round's rejection, caused by the signer's
    expect(rejected).toBeInstanceOf(SiteRoundRejected);
    expect(rejected).toMatchObject({ cause: rejection });
  });
});

describe('site sign-in of a group', () => {
  it('As a user signing in to two origins of a group, I give both the same address from the one grant', async () => {
    // Given a sign-in of one origin of the group the user consented to, whose token the other origin keeps
    const store = createSiteGrantStore(memorySiteGrantsIdb());
    const first = await harness({ store, groupToken: 'my group' });
    await consentAndStore(first.flow, first);
    await first.closed;
    const firstPost = resultOf(first.posts);
    const second = await harness({
      store,
      origin: 'https://shop.my-site.com',
      siteToken: firstPost.site_token ?? null,
      groupToken: 'my group',
    });

    // When the other origin signs in with that token
    await second.until('window');
    second.windowFlow().stored();
    await second.closed;

    // Then both signed with the account the site named and got the same address, each in an assertion of its own origin
    // with the group line, with one consent and the counts of a group
    const secondPost = resultOf(second.posts);
    expect([...first.signs, ...second.signs].map(sign => sign.account)).toEqual([ACCOUNT, ACCOUNT]);
    expect(secondPost.result.address).toBe(firstPost.result.address);
    expect(firstPost.result.assertion.message).toContain('URI: https://my-site.com\n');
    expect(secondPost.result.assertion.message).toContain('URI: https://shop.my-site.com\n');
    expect(secondPost.result.assertion.message.split('\n').at(-1)).toBe('- urn:dotli:group:my%20group');
    expect(second.views).not.toContain('consent');
    expect(second.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'group' }]);
  });
});
