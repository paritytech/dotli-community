// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProductAccountId } from '@parity/truapi';
import { describe, expect, it, onTestFinished } from 'vitest';
import { base64urlnopad, hex } from '@scure/base';
import type { TxCreator } from 'polkadot-api';
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
import { createSiteGrantStore, type SiteGrant } from '@dotli/storage';
import { memorySiteGrantsIdb } from '@dotli/storage/testing';
import { createFakeMessageBus, createFakeWindowHandle } from '../session-handoff/messages.fake.js';
import { openerParty } from '../session-handoff/opener-rule.js';
import { createResponder, type Responder, type ResponderState } from '../session-handoff/responder.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import type { MainAccount } from './main-account.js';
import { displayAccount } from './site-account.js';
import type { DisplayCall } from './site-call.js';
import { SiteChainError, type SiteChain, type SiteDecodedCall } from './site-chain.js';
import type { SiteRound, SiteScreen } from './site-round.js';
import { parsePublicSuffixList } from './public-suffix-list.js';
import type { SiteGroups } from './site-groups.js';
import { SiteAccountReadError, SiteAccountRejectedError, type SiteAccountReader } from './site-account-reader.js';
import { createSiteTransaction, siteTransactionAction, type SiteTransactionResult } from './site-transaction.js';
import { SiteTxError } from './site-tx-signer.js';

const SELF = 'https://dot.li';
const ORIGIN = 'https://my-site.com';
const NET = NetworkName.PASEO;
const NETWORK = NETWORK_NAME_TO_SERVICES_CONFIG[NET];
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: `myapp.${NETWORK.dotns.TLD}`,
  derivationIndex: { tag: 'Index', value: 0 },
};
const NOW = Date.parse('2026-10-25T15:00:00.000Z');

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(blake2b(fromHex(MAIN_KEY), 32));
/** The main account the window's core reports. */
const MAIN: MainAccount = { owner: OWNER, username: { name: 'alice.dot', kind: 'full' } };
// What the main store holds beside the main account, which the round never reads: a paired session and a local wallet.
const MAIN_BLOB = 'MAIN-SESSION-BLOB';
const WALLET_ENTROPY = new Uint8Array(16).fill(0x5c);
const WALLET_ACCOUNT = '5LocalWalletIdentityAccountOfTheMainStore';

const SITE_KEY = new Uint8Array(32).fill(0x22);

const CALL = Uint8Array.of(0x0a, 0x03, 0x00, 0x01, 0x02);
const DISPLAY: DisplayCall = {
  name: 'Balances.transfer_keep_alive',
  args: [
    { name: 'dest', value: '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty' },
    { name: 'value', value: '1000000000000' },
  ],
};

/** The signed transaction the fake creator builds, in uppercase hex, which the site gets in lowercase. */
const SIGNED_TX = `0x${'5E'.repeat(80)}`;

const TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(1));
const NEW_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(2));

/** The registrable domains of a few rules of the Public Suffix List, as the window's loaded list gives them. */
const SUFFIXES = parsePublicSuffixList('com\nli\n');
const GROUPS: SiteGroups = { registrable: hostname => Promise.resolve(SUFFIXES.registrable(hostname)) };

const BINDINGS = {} as Parameters<TxCreator>[2];

function payloadOf(call: Uint8Array): Parameters<TxCreator>[0] {
  return {
    version: 1,
    signer: null,
    callData: toHex(call),
    extensions: [],
    txExtVersion: 0,
    context: {
      metadata: '0x6d657461',
      token: null,
      bestBlockHeight: 1,
      bestBlockHash: `0x${'33'.repeat(32)}`,
      genesisHash: NETWORK.assethub.genesis,
    },
  };
}

interface ChainScript {
  /** Failures `open` answers with, one per call, before it opens. */
  openFailures?: Error[];
  /** The failure every decode answers with. */
  decodeFailure?: Error;
  /** The failure every close throws, after it closed. */
  closeFailure?: Error;
  /** Failures the chain answers builds with before it asks the creator, one per build. */
  buildFailures?: Error[];
  /** What each build waits on while it fills the extensions, before it asks the creator. */
  filling?: () => Promise<void>;
}

/**
 * Asset Hub that decodes any call and builds its transaction with the creator it is given, unless its script says
 * otherwise. It can send nothing. Each decode and build adds its name to `steps`.
 */
function fakeChain(script: ChainScript, steps: string[] = []) {
  const openFailures = [...(script.openFailures ?? [])];
  const buildFailures = [...(script.buildFailures ?? [])];
  const record = { opened: 0, closed: 0, decoded: 0, built: 0 };
  // The genesis of each open.
  const opens: string[] = [];
  // Each call the chain decoded, and each it was asked to build, with the key it was built for.
  const decodedCalls: SiteDecodedCall[] = [];
  const builtCalls: SiteDecodedCall[] = [];
  const builtKeys: Uint8Array[] = [];
  let allClosed = deferred<undefined>();
  const chain: SiteChain = {
    open: genesis => {
      opens.push(genesis);
      const failure = openFailures.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      record.opened += 1;
      allClosed = deferred<undefined>();
      return Promise.resolve({
        decode: () => {
          record.decoded += 1;
          steps.push('decode');
          if (script.decodeFailure !== undefined) {
            return Promise.reject(script.decodeFailure);
          }
          const decoded: SiteDecodedCall = {
            display: DISPLAY,
            transaction: { create: () => Promise.reject(new Error('The fake chain builds through its session')) },
          };
          decodedCalls.push(decoded);
          return Promise.resolve(decoded);
        },
        create: async (decoded, creator, publicKey) => {
          record.built += 1;
          steps.push('create');
          builtCalls.push(decoded);
          builtKeys.push(publicKey);
          const failure = buildFailures.shift();
          if (failure !== undefined) {
            throw failure;
          }
          await script.filling?.();
          return fromHex(await creator(payloadOf(CALL), {}, BINDINGS, false));
        },
        close: () => {
          record.closed += 1;
          allClosed.resolve(undefined);
          if (script.closeFailure !== undefined) {
            throw script.closeFailure;
          }
        },
      });
    },
  };
  return { chain, record, opens, decodedCalls, builtCalls, builtKeys, closed: () => allClosed.promise };
}

/** A creator per named account that signs at once, unless the test gave it what each signing answers. */
function fakeTxSigner(builds: (() => Promise<string>)[] = []) {
  const queue = [...builds];
  const signedBy: ProductAccountId[] = [];
  return {
    signedBy,
    txSigner: {
      creator:
        (account: ProductAccountId, onAsk?: () => void): TxCreator =>
        () => {
          signedBy.push(account);
          onAsk?.();
          const build = queue.shift();
          return build === undefined ? Promise.resolve(SIGNED_TX) : build();
        },
    },
  };
}

/**
 * An account reader that answers each failure it was given first, then each held read in order, which the test
 * resolves when it chooses, and then reads the site account at once.
 */
function fakeAccountReader(failures: Error[] = [], steps: string[] = [], reads: (() => Promise<Uint8Array>)[] = []) {
  const queue = [...failures];
  const held = [...reads];
  const accounts: ProductAccountId[] = [];
  const accountReader: Pick<SiteAccountReader, 'account'> = {
    account: account => {
      accounts.push(account);
      steps.push('account');
      const failure = queue.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const read = held.shift();
      return read === undefined ? Promise.resolve(SITE_KEY) : read();
    },
  };
  return { accountReader, accounts };
}

function grantOf(): SiteGrant {
  return {
    token: TOKEN,
    origin: ORIGIN,
    owner: OWNER,
    firstUsedAt: NOW - 1000,
    lastUsedAt: NOW - 1000,
  };
}

/** One message the window posted to its opener. */
type Post =
  | { type: 'dotli:s:result'; result: SiteTransactionResult; site_token?: string }
  | { type: 'dotli:s:refused'; reason: string }
  | { type: 'dotli:s:cancelled' };

interface HarnessOptions extends ChainScript {
  siteToken?: string | null;
  groupToken?: string | null;
  grants?: SiteGrant[];
  builds?: (() => Promise<string>)[];
  accountFailures?: Error[];
  /** What each site account read waits on after the failures, which holds the read open until the test resolves it. */
  accountReads?: (() => Promise<Uint8Array>)[];
  /** What every new grant token throws, in place of a token. */
  tokenFailure?: Error;
}

/** A responder that records what it posts and ends its round on its first terminal call. */
function recordingResponder() {
  const posts: Post[] = [];
  const round = createSyncStore<ResponderState>('testSiteResponder', {
    kind: 'vetted',
    origin: ORIGIN,
    party: 'third',
  });
  const end = (post: Post, state: ResponderState): void => {
    const { kind } = round.get();
    if (kind === 'answered' || kind === 'refused') {
      return;
    }
    posts.push(post);
    round.set(state);
  };
  const responder: Pick<Responder<unknown>, 'send' | 'refuse' | 'cancel' | 'state' | 'subscribe'> = {
    state: round.get,
    subscribe: listener =>
      round.subscribe(() => {
        listener(round.get());
      }),
    send: (result, siteToken) => {
      end(
        {
          type: 'dotli:s:result',
          result: result as SiteTransactionResult,
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
  return { responder, posts };
}

/**
 * A site's transaction over fakes: `responder` answers the site, Asset Hub plays its script, the creator signs at
 * once and the account reader reads the site account at once, unless the test says otherwise, such as reads it holds
 * open. `steps` names each decode, account read, review and build in the order they happened.
 */
async function roundOver(
  options: HarnessOptions,
  responder: Pick<Responder<unknown>, 'send' | 'refuse' | 'cancel' | 'state' | 'subscribe'>,
) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const grants = createSiteGrantStore(memorySiteGrantsIdb());
  for (const grant of options.grants ?? []) {
    await grants.save(grant);
  }
  const steps: string[] = [];
  const chain = fakeChain(options, steps);
  const tx = fakeTxSigner(options.builds);
  const { accountReader, accounts } = fakeAccountReader(options.accountFailures, steps, options.accountReads);
  const windowFlows: (() => void)[] = [];
  const closed = deferred<undefined>();
  const flow = createSiteTransaction({
    request: {
      round: 'r1',
      account: ACCOUNT,
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
      chain: NETWORK.assethub.genesis,
      call: toHex(CALL),
    },
    call: CALL,
    origin: ORIGIN,
    self: SELF,
    responder,
    grants,
    groups: GROUPS,
    chain: chain.chain,
    txSigner: tx.txSigner,
    accountReader,
    mainAccount: () => Promise.resolve(MAIN),
    startWindowFlow: stored => {
      windowFlows.push(stored);
    },
    now: () => NOW,
    randomToken: () => {
      if (options.tokenFailure !== undefined) {
        throw options.tokenFailure;
      }
      return NEW_TOKEN;
    },
    close: () => {
      closed.resolve(undefined);
    },
  });
  const views: SiteScreen['view'][] = [flow.screen.get().view];
  flow.screen.subscribe(() => {
    const { view } = flow.screen.get();
    views.push(view);
    if (view === 'site-review') {
      steps.push('review');
    }
  });
  return {
    flow,
    grants,
    chain,
    signedBy: tx.signedBy,
    accounts,
    views,
    steps,
    metrics,
    errors,
    closed: closed.promise,
    /** The window flow the round started says a sign-in is stored. */
    stored: () => {
      must(windowFlows[0], 'a started window flow')();
    },
    until: (view: SiteScreen['view']) => untilView(flow.screen, view),
  };
}

async function harness(options: HarnessOptions = {}) {
  const { responder, posts } = recordingResponder();
  return { ...(await roundOver(options, responder)), posts };
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

type Harness = Awaited<ReturnType<typeof roundOver>>;

/** Consents on the consent view, and the window flow says a sign-in is stored. */
async function consentAndStore(h: Harness): Promise<void> {
  await h.until('consent');
  await h.flow.consent();
  h.stored();
}

/** Signs on the review once it shows. */
async function sign(flow: SiteRound, h: Harness): Promise<void> {
  await h.until('site-review');
  h.steps.push('confirm');
  flow.confirm();
}

describe('site transaction', () => {
  it('As a site on a new origin, I ask for my call to be signed and the consent names my origin alone', async () => {
    // Given a site of no group the main store keeps no grant for
    const h = await harness();

    // When the round shows its consent
    await h.until('consent');

    // Then the consent carries the site's origin and no group
    expect(h.flow.screen.get()).toEqual({ view: 'consent', origin: ORIGIN, group: null });
  });

  it('As a site, I ask for my call to be signed and get it signed by my account with nothing sent', async () => {
    // Given a site the main store keeps no grant for, on its review
    const h = await harness();
    await consentAndStore(h);
    await h.until('site-review');
    const review = h.flow.screen.get();

    // When the user signs on the review
    h.steps.push('confirm');
    h.flow.confirm();
    await h.closed;

    // Then the call was decoded, the review shown and confirmed, the account read and the transaction built, in that
    // order, for the account the site named, and the site got the signed transaction in lowercase hex with a new token
    expect(h.steps).toEqual(['decode', 'review', 'confirm', 'account', 'create']);
    expect(review).toEqual({ view: 'site-review', origin: ORIGIN, call: DISPLAY, account: displayAccount(ACCOUNT) });
    const post = resultOf(h.posts);
    expect(post.result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(post.site_token).toBe(NEW_TOKEN);
    expect(h.signedBy).toEqual([ACCOUNT]);
    expect(h.chain.builtKeys).toEqual([SITE_KEY]);
    expect(await h.grants.list()).toEqual([
      { token: NEW_TOKEN, origin: ORIGIN, owner: OWNER, firstUsedAt: NOW, lastUsedAt: NOW },
    ]);
    expect(h.views).toEqual([
      'site-signing',
      'consent',
      'window',
      'site-signing',
      'site-review',
      'site-sharing',
      'site-signing',
      'site-approving',
    ]);
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1, built: 1 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'signed', reason: 'new' }]);
  });

  it('As a user, I see the transaction prepared while its extensions fill and am asked to approve only once the phone is', async () => {
    // Given a chain that is still filling the extensions once the user signed on the review
    const filling = deferred<undefined>();
    const filled = deferred<undefined>();
    const h = await harness({
      filling: () => {
        filling.resolve(undefined);
        return filled.promise;
      },
    });
    await consentAndStore(h);
    await sign(h.flow, h);

    // When the chain fills the extensions, and then the phone is asked
    await filling.promise;
    const whileFilling = h.flow.screen.get();
    filled.resolve(undefined);
    await h.closed;

    // Then the window showed the working view while the extensions filled, and Approve only once the phone was asked
    expect(whileFilling).toEqual({ view: 'site-signing', origin: ORIGIN, route: 'sign' });
    expect(h.views.slice(-4)).toEqual(['site-review', 'site-sharing', 'site-signing', 'site-approving']);
    expect(resultOf(h.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
  });

  it('As a user, I sign the call the review showed, built from that decode and never decoded again', async () => {
    // Given a site's round on its review
    const h = await harness();
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the call was decoded once, for the review, and that decode was built
    expect(h.chain.decodedCalls).toHaveLength(1);
    expect(h.chain.builtCalls).toHaveLength(1);
    expect(h.chain.builtCalls[0]).toBe(h.chain.decodedCalls[0]);
  });

  it('As a user, I reject the transaction on the phone and the site hears I cancelled', async () => {
    // Given a phone on which the user rejects the transaction
    const h = await harness({ builds: [() => Promise.reject(new SiteTxError('rejected', { tag: 'Cancelled' }))] });
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;
    await h.chain.closed();

    // Then the site hears the round was cancelled, nothing was kept, and the chain was let go
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1 });
    expect(await h.grants.list()).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'cancelled', reason: 'phone' }]);
  });

  it('As a user who cancels while the phone asks me to approve, the site hears I cancelled and the chain is let go at once', async () => {
    // Given a phone that has not answered yet
    const built = deferred<string>();
    const h = await harness({ builds: [() => built.promise] });
    await consentAndStore(h);
    await sign(h.flow, h);
    await h.until('site-approving');

    // When the user cancels, and the phone answers only once the chain was let go
    h.flow.cancel();
    await h.chain.closed();
    built.resolve(SIGNED_TX);
    await h.closed;

    // Then the site hears the round was cancelled, once, and the chain was let go before the phone answered
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.chain.record).toMatchObject({ closed: 1 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a site, I ask for a transaction the wallet cannot sign and am refused as invalid', async () => {
    // Given a phone that does not support the transaction
    const unsupported = new SiteTxError('unsupported', { tag: 'NotSupported' });
    const h = await harness({ builds: [() => Promise.reject(unsupported)] });
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the site is refused for the transaction, the wallet's error was reported once, and the chain was let go
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_invalid' }]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.args).toContainEqual(expect.objectContaining({ cause: unsupported }));
    expect(h.chain.record.closed).toBe(1);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'transaction_invalid' },
    ]);
  });

  it('As a user, I press Try again after a failed build and the window builds again from the chain', async () => {
    // Given a phone whose first build fails
    const h = await harness({ builds: [() => Promise.reject(new SiteTxError('failed', new Error('No answer')))] });
    await consentAndStore(h);
    await sign(h.flow, h);
    await h.until('site-failed');
    const failed = h.flow.screen.get();

    // When the user tries again and signs once more
    // The retry runs until the round ends, so the user signs while it runs.
    const retried = h.flow.retry();
    await sign(h.flow, h);
    await retried;
    await h.closed;

    // Then the failure offered Try again, the retry opened the chain again and built again, the site account was read
    // once and the window asked to open Polkadot App once, and the site got the signed transaction
    expect(failed).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.views.filter(view => view === 'site-sharing')).toHaveLength(1);
    expect(h.chain.record).toMatchObject({ opened: 2, closed: 2, built: 2 });
    expect(h.accounts).toEqual([ACCOUNT]);
    expect(resultOf(h.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'error', reason: 'build' },
      { outcome: 'signed', reason: 'new' },
    ]);
  });

  it('As a user whose chain fails while the transaction is built, I see the failure and can try again', async () => {
    // Given a chain that fails before it asks the creator
    const h = await harness({ buildFailures: [new SiteChainError('unreachable', 'Asset Hub did not answer')] });
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.until('site-failed');

    // Then the failure offers Try again and names the chain, nothing went to the site and the phone was not asked
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.posts).toEqual([]);
    expect(h.signedBy).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it('As a user whose chain client fails to close after the transaction was signed, the site still gets it', async () => {
    // Given a chain whose session fails to close
    const closing = new Error('The chain client could not be destroyed');
    const h = await harness({ closeFailure: closing });
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the site got its result once, no failure showed, and the failed close was reported once and counted for the
    // chain
    expect(resultOf(h.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(h.posts).toHaveLength(1);
    expect(h.views).not.toContain('site-failed');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.args).toContainEqual(expect.objectContaining({ cause: closing }));
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'error', reason: 'chain' },
      { outcome: 'signed', reason: 'new' },
    ]);
  });

  it('As a site, I have my call decoded and built on the Asset Hub my request named', async () => {
    // Given a site's request checked against its network's Asset Hub
    const h = await harness();
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the window opened that Asset Hub
    expect(h.chain.opens).toEqual([NETWORK.assethub.genesis]);
  });

  it('As a site, I send a call the window cannot decode and am refused before the phone is asked', async () => {
    // Given a chain on which the call does not decode
    const h = await harness({ decodeFailure: new SiteChainError('undecodable', 'The call does not decode') });

    // When the round runs for the main account
    await consentAndStore(h);
    await h.closed;

    // Then the site is refused as a bad request with nothing reported, and no review showed, no site account was read
    // and nothing was built
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(h.errors).toEqual([]);
    expect(h.views).not.toContain('site-review');
    expect(h.accounts).toEqual([]);
    expect(h.signedBy).toEqual([]);
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1, built: 0 });
  });

  it('As a user whose chain cannot be reached, I see the failure and can try again', async () => {
    // Given a chain that cannot be opened
    const h = await harness({ openFailures: [new SiteChainError('unreachable', 'Asset Hub is not reachable')] });

    // When the round runs for the main account
    await consentAndStore(h);
    await h.until('site-failed');

    // Then the failure offers Try again and names the chain, and no site account was read
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.accounts).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it("As a user whose window runs on another network than the site's request, I see the failure with no Try again", async () => {
    // Given a chain that refuses the request's Asset Hub as another network's
    const h = await harness({ openFailures: [new SiteChainError('mismatch', 'Another network')] });

    // When the round runs for the main account
    await consentAndStore(h);
    await h.until('site-failed');

    // Then the failure offers no Try again and names the chain, and no site account was read
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: false });
    expect(h.accounts).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it('As a user whose site I used before, I sign with no consent and the account the site named is read', async () => {
    // Given a grant for this site and this main account
    const h = await harness({ siteToken: TOKEN, grants: [grantOf()] });
    await h.until('window');
    h.stored();

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then no consent showed, the account the site named was read, and the site keeps its token
    expect(h.views).not.toContain('consent');
    expect(h.accounts).toEqual([ACCOUNT]);
    expect(resultOf(h.posts).site_token).toBeUndefined();
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'signed', reason: 'known' }]);
  });

  it('As a site of a group, I sign with the account I named and the group keeps the grant', async () => {
    // Given a site that asks under a group token, with no grant kept
    const h = await harness({ groupToken: 'my group' });
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the account the site named was read, the site got a new token for a grant of the group, counted as a group's
    expect(h.accounts).toEqual([ACCOUNT]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
    expect((await h.grants.list()).map(grant => grant.group)).toEqual([
      { registrable: 'my-site.com', token: 'my group', origins: [ORIGIN] },
    ]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'signed', reason: 'group' }]);
  });

  it('As a user whose site account could not be read, I see the failure counted for the account', async () => {
    // Given an account reader whose account read fails
    const h = await harness({ accountFailures: [new SiteAccountReadError({ tag: 'Denied' })] });

    // When the user signs on the review and the read fails
    await consentAndStore(h);
    await sign(h.flow, h);
    await h.until('site-failed');

    // Then the review showed first, the failure offers Try again and names the account, and the chain was let go with
    // nothing built
    expect(h.views).toContain('site-review');
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1, built: 0 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'account' }]);
  });

  it('As a user on the review, I see my call before the phone is asked for my site account', async () => {
    // Given a site's round that has not been confirmed
    const h = await harness();
    await consentAndStore(h);

    // When the review shows
    await h.until('site-review');

    // Then the phone was not asked for the site account
    expect(h.accounts).toEqual([]);
  });

  it('As a user who confirms the review, I am asked to open Polkadot App while the window reads my site account', async () => {
    // Given a phone that has not answered the site account read yet
    const read = deferred<Uint8Array>();
    const h = await harness({ accountReads: [() => read.promise] });
    await consentAndStore(h);

    // When the user signs on the review, and the window asks the phone for the site account
    await sign(h.flow, h);
    await h.until('site-sharing');
    const sharing = h.flow.screen.get();
    const builtWhileAsking = h.chain.record.built;
    read.resolve(SITE_KEY);
    await h.closed;

    // Then the window asked to open Polkadot App before anything was built, and the site got its signed transaction
    expect(sharing).toEqual({ view: 'site-sharing', origin: ORIGIN });
    expect(builtWhileAsking).toBe(0);
    expect(resultOf(h.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
  });

  it('As a user who is asked to open Polkadot App, I cancel and the site hears I cancelled', async () => {
    // Given a phone that has not answered the site account read yet
    const read = deferred<Uint8Array>();
    const h = await harness({ accountReads: [() => read.promise] });
    await consentAndStore(h);
    await sign(h.flow, h);
    await h.until('site-sharing');

    // When the user cancels, and the phone answers after
    h.flow.cancel();
    read.resolve(SITE_KEY);
    await h.closed;

    // Then the site hears the round was cancelled, and nothing was built
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.chain.record).toMatchObject({ built: 0 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user who is asked to share my account, I reject it on the phone and the site hears I cancelled', async () => {
    // Given a phone on which the user rejects sharing the site account
    const rejection = new SiteAccountRejectedError({ tag: 'Domain', value: { tag: 'V1', value: { tag: 'Rejected' } } });
    const h = await harness({ accountFailures: [rejection] });
    await consentAndStore(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the site hears the round was cancelled, and the phone was never asked to sign
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.signedBy).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'cancelled', reason: 'phone' }]);
  });

  it('As a user whose site account read failed, I press Try again and see the review again before the phone is asked again', async () => {
    // Given a phone whose first site account read fails
    const h = await harness({ accountFailures: [new SiteAccountReadError({ tag: 'Denied' })] });
    await consentAndStore(h);
    await sign(h.flow, h);
    await h.until('site-failed');

    // When the user tries again and signs on the review once more
    const retried = h.flow.retry();
    await sign(h.flow, h);
    await retried;
    await h.closed;
    const afterFailure = h.views.slice(h.views.indexOf('site-failed'));

    // Then the phone was asked twice, the review showed again before the second ask, and the site got its transaction
    expect(h.accounts).toEqual([ACCOUNT, ACCOUNT]);
    expect(resultOf(h.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(afterFailure.indexOf('site-review')).toBeGreaterThan(-1);
    expect(afterFailure.indexOf('site-review')).toBeLessThan(afterFailure.indexOf('site-sharing'));
  });

  it('As a user, I never hand a site my main session, main account or local wallet', async () => {
    // Given a session window's real responder, vetted by the site that opened it, and a main store with a paired
    // session and a local wallet beside it
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
    const h = await roundOver({}, responder);
    await consentAndStore(h);

    // When the user signs on the review and the round runs to its result
    await sign(h.flow, h);
    await h.closed;

    // Then the site got its signed transaction, and no message it got carries any of them
    // A byte array writes as its hex, since JSON would write it as an object of indices.
    const sent = opener.posted.map(({ message }) =>
      JSON.stringify(message, (_key, value: unknown) => (value instanceof Uint8Array ? toHex(value) : value)),
    );
    const secrets = [MAIN_BLOB, 'a'.repeat(64), hex.encode(WALLET_ENTROPY), WALLET_ACCOUNT, OWNER];
    expect(sent.filter(message => message.includes('dotli:s:result'))).toHaveLength(1);
    expect(sent.join('\n')).toContain(SIGNED_TX.toLowerCase());
    for (const message of sent) {
      for (const secret of secrets) {
        expect(message).not.toContain(secret);
      }
    }
  });
});

describe('site transaction action', () => {
  it('As a site, I am refused with bad_request for a call that does not decode, before the site account is read', async () => {
    // Given the transaction action over a chain on which the call does not decode
    const chain = fakeChain({ decodeFailure: new SiteChainError('undecodable', 'The call does not decode') });
    const { accountReader, accounts } = fakeAccountReader();
    const action = siteTransactionAction({
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      account: ACCOUNT,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      accountReader,
    });
    const shown: string[] = [];

    // When the action runs
    const refusal: unknown = await action
      .run({
        main: { owner: OWNER, username: null },
        show: screen => {
          shown.push(screen.view);
        },
        confirmed: () => Promise.resolve(),
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    // Then it refuses the site with bad_request, showed nothing and read no account
    expect(refusal).toMatchObject({ name: 'SiteRoundRefusal', reason: 'bad_request' });
    expect(shown).toEqual([]);
    expect(accounts).toEqual([]);
    expect(action.route).toBe('sign');
  });

  it('As a round that ended before its transaction ran, I close the chain session once and ask nothing of it or the phone', async () => {
    // Given the transaction action of a round that already ended
    const chain = fakeChain({});
    const { accountReader, accounts } = fakeAccountReader();
    const action = siteTransactionAction({
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      account: ACCOUNT,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      accountReader,
    });
    const ended = new AbortController();
    ended.abort();
    const shown: string[] = [];

    // When the action runs
    const outcome: unknown = await action
      .run({
        main: { owner: OWNER, username: null },
        show: screen => {
          shown.push(screen.view);
        },
        confirmed: () => Promise.resolve(),
        signal: ended.signal,
      })
      .catch((caught: unknown) => caught);

    // Then the run rejected with the round's end, the session closed once, and nothing was decoded, read or shown
    expect(outcome).toBe(ended.signal.reason);
    expect(chain.record).toMatchObject({ opened: 1, closed: 1, decoded: 0 });
    expect(accounts).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('As a user who signs in again with another account before Try again, the site account is read again for the nonce', async () => {
    // Given the transaction action whose first build fails, and an account reader that reads another key for each main account
    const chain = fakeChain({ buildFailures: [new Error('Asset Hub stopped answering')] });
    const firstKey = new Uint8Array(32).fill(0x31);
    const secondKey = new Uint8Array(32).fill(0x32);
    const keys = [firstKey, secondKey];
    const accounts: ProductAccountId[] = [];
    const action = siteTransactionAction({
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      account: ACCOUNT,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      accountReader: {
        account: account => {
          accounts.push(account);
          return Promise.resolve(must(keys.shift(), 'a key for each read'));
        },
      },
    });
    const runFor = (main: MainAccount) =>
      action.run({
        main,
        show: () => undefined,
        confirmed: () => Promise.resolve(),
        signal: new AbortController().signal,
      });
    await runFor(MAIN).catch(() => undefined);
    const otherMain: MainAccount = { owner: toHex(blake2b(fromHex(`0x${'b'.repeat(64)}`), 32)), username: null };

    // When the round runs again for the other main account
    await runFor(otherMain);

    // Then the site account was read again, and the second build filled the nonce from the second key
    expect(accounts).toEqual([ACCOUNT, ACCOUNT]);
    expect(chain.builtKeys).toEqual([firstKey, secondKey]);
  });

  it('As a user who cancels while the phone asks me to approve, the chain session closes at once and only once', async () => {
    // Given the transaction action waiting on a phone that has not answered yet
    const chain = fakeChain({});
    const built = deferred<string>();
    const action = siteTransactionAction({
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      account: ACCOUNT,
      chain: chain.chain,
      txSigner: fakeTxSigner([() => built.promise]).txSigner,
      accountReader: fakeAccountReader().accountReader,
    });
    const ended = new AbortController();
    const signing = deferred<undefined>();
    const running = action.run({
      main: { owner: OWNER, username: null },
      show: screen => {
        if (screen.view === 'site-approving') {
          signing.resolve(undefined);
        }
      },
      confirmed: () => Promise.resolve(),
      signal: ended.signal,
    });
    await signing.promise;

    // When the round ends, and the phone answers after the chain was let go
    ended.abort();
    await chain.closed();
    built.resolve(SIGNED_TX);
    await running;

    // Then the session closed once, when the round ended, and not again as the run ended
    expect(chain.record).toMatchObject({ opened: 1, closed: 1 });
  });

  it('As a round that ended while the phone was asked for the site account, I build nothing once the phone answers', async () => {
    // Given the transaction action waiting on a phone that has not answered the site account read yet
    const chain = fakeChain({});
    const read = deferred<Uint8Array>();
    const action = siteTransactionAction({
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      account: ACCOUNT,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      accountReader: fakeAccountReader([], [], [() => read.promise]).accountReader,
    });
    const ended = new AbortController();
    const sharing = deferred<undefined>();
    const running = action.run({
      main: { owner: OWNER, username: null },
      show: screen => {
        if (screen.view === 'site-sharing') {
          sharing.resolve(undefined);
        }
      },
      confirmed: () => Promise.resolve(),
      signal: ended.signal,
    });
    await sharing.promise;

    // When the round ends, and the phone answers after
    ended.abort();
    read.resolve(SITE_KEY);

    // Then the run rejects with the round's end, and the session closed once with nothing built
    await expect(running).rejects.toBe(ended.signal.reason);
    expect(chain.record).toMatchObject({ opened: 1, closed: 1, built: 0 });
  });
});
