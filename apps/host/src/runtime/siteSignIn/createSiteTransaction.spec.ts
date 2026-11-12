// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId, type ProductAccountId } from '@parity/truapi';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { TxCreator } from 'polkadot-api';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { hashBlake2b, createDeferred, fromHex, toHex, waitForStatus } from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrant } from '@dotli/storage';
import { createMemorySiteGrantsIdb } from '@dotli/storage/testing';
import type { Responder } from '../sessionHandoff/createResponder.js';
import type { MainAccount } from './createMainAccountSource.js';
import { toDisplayAccount } from './toDisplayAccount.js';
import type { DisplayCall } from './toDisplayCall.js';
import { SiteChainError, type SiteChain, type SiteDecodedCall } from './createSiteChain.js';
import type { SiteAction, SiteActionScreen, SiteScreen } from './createSiteRound.js';
import { SiteAccountReadError, SiteAccountRejectedError, type SiteAccountReader } from './createSiteAccountReader.js';
import {
  createSiteTransaction,
  createSiteTransactionAction,
  type SiteTransactionResult,
} from './createSiteTransaction.js';
import { SiteTxError, type SiteTxSigner } from './createSiteTxSigner.js';
import { createRecordingResponder, createVettedResponder } from '../sessionHandoff/createResponder.fake.js';
import { consentAndStore } from '../../testing/consentAndStore.js';
import { createGrant } from '../../testing/createGrant.js';
import { findLeakedSecrets } from '../../testing/findLeakedSecrets.js';
import { getResult } from '../../testing/getResult.js';
import {
  MAIN_ACCOUNT,
  MAIN_OWNER,
  NEW_SITE_TOKEN,
  ROUND_NOW,
  SITE_ORIGIN,
  SITE_TOKEN,
} from '../../testing/siteRoundConstants.js';
import { TX_BINDINGS } from '../../testing/txBindings.js';
import { waitForView } from '../../testing/waitForView.js';
import { writeMessages } from '../../testing/writeMessages.js';
import { SITE_GROUPS } from './createSiteGroups.fake.js';

type CreateFakeChainParams = {
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
  /** What each decode waits on before it decodes. */
  decoding?: () => Promise<void>;
  /** Where each decode and build adds its name. */
  steps?: string[];
};

type CreateFakeTxSignerParams = {
  /** What each signing answers, in order, before the creator signs at once. */
  builds?: (() => Promise<string>)[] | undefined;
};

type CreateFakeAccountReaderParams = {
  /** Failures the reader answers with, one per read, before it reads the site account. */
  failures?: Error[] | undefined;
  /** Where each account read adds its name. */
  steps?: string[];
  /** What each read waits on after the failures, which holds the read open until the test resolves it. */
  reads?: (() => Promise<Uint8Array>)[] | undefined;
};

type StartTransactionParams = {
  siteToken?: string | null;
  groupToken?: string | null;
  grants?: SiteGrant[];
  builds?: (() => Promise<string>)[];
  accountFailures?: Error[];
  /** What each site account read waits on after the failures, which holds the read open until the test resolves it. */
  accountReads?: (() => Promise<Uint8Array>)[];
  /** What every new grant token throws, in place of a token. */
  tokenFailure?: Error;
} & Omit<CreateFakeChainParams, 'steps'>;

/** The responder calls a site's round makes. */
type RoundResponder = Pick<Responder<unknown>, 'send' | 'refuse' | 'cancel' | 'state'>;

/** A started transaction round over fakes. */
type StartedTransaction = Awaited<ReturnType<typeof startTransactionWith>>;

const SELF = 'https://dot.li';
const NETWORK_NAME = 'paseo-next-v2';
const SERVICES = NETWORK_NAME_TO_SERVICES_CONFIG[NETWORK_NAME];
const ACCOUNT: ProductAccountId = {
  dotNsIdentifier: asProductId(`myapp.${SERVICES.dotns.TLD}`),
  derivationIndex: { tag: 'Index', value: 0 },
};
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

/** The payload papi hands a creator for `call` once its fillers filled every extension. */
function createTxPayload(call: Uint8Array): Parameters<TxCreator>[0] {
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
      genesisHash: SERVICES.assethub.genesis,
    },
  };
}

/**
 * Asset Hub that decodes any call and builds its transaction with the creator it is given, unless its script says
 * otherwise. It can send nothing. Each decode and build adds its name to `steps`.
 */
function createFakeChain({ steps = [], ...script }: CreateFakeChainParams) {
  const openFailures = [...(script.openFailures ?? [])];
  const buildFailures = [...(script.buildFailures ?? [])];
  const record = { opened: 0, closed: 0, decoded: 0, built: 0 };
  // The genesis of each open.
  const opens: string[] = [];
  // Each call the chain decoded, and each it was asked to build, with the key it was built for.
  const decodedCalls: SiteDecodedCall[] = [];
  const builtCalls: SiteDecodedCall[] = [];
  const builtKeys: Uint8Array[] = [];
  let allClosed = createDeferred<undefined>();
  const chain: SiteChain = {
    open(genesis) {
      opens.push(genesis);
      const failure = openFailures.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      record.opened += 1;
      allClosed = createDeferred<undefined>();
      return Promise.resolve({
        async decode() {
          record.decoded += 1;
          steps.push('decode');
          await script.decoding?.();
          if (script.decodeFailure !== undefined) {
            throw script.decodeFailure;
          }
          const decoded: SiteDecodedCall = {
            display: DISPLAY,
            transaction: { create: () => Promise.reject(new Error('The fake chain builds through its session')) },
          };
          decodedCalls.push(decoded);
          return decoded;
        },
        async create({ call: decoded, creator, publicKey }) {
          record.built += 1;
          steps.push('create');
          builtCalls.push(decoded);
          builtKeys.push(publicKey);
          const failure = buildFailures.shift();
          if (failure !== undefined) {
            throw failure;
          }
          await script.filling?.();
          return fromHex(await creator(createTxPayload(CALL), {}, TX_BINDINGS, false));
        },
        close() {
          record.closed += 1;
          allClosed.resolve(undefined);
          if (script.closeFailure !== undefined) {
            throw script.closeFailure;
          }
        },
      });
    },
  };
  return {
    chain,
    record,
    opens,
    decodedCalls,
    builtCalls,
    builtKeys,
    /** Resolves once the session the chain opened last was closed. */
    waitForClosed: () => allClosed.promise,
  };
}

/** A creator per named account that signs at once, unless the test gave it what each signing answers. */
function createFakeTxSigner({ builds = [] }: CreateFakeTxSignerParams = {}) {
  const queue = [...builds];
  const signedBy: ProductAccountId[] = [];
  const txSigner: SiteTxSigner = {
    creator(account, { onAsk } = {}) {
      function signTransaction(): Promise<string> {
        signedBy.push(account);
        onAsk?.();
        const build = queue.shift();
        return build === undefined ? Promise.resolve(SIGNED_TX) : build();
      }
      return signTransaction;
    },
  };
  return { signedBy, txSigner };
}

/**
 * An account reader that answers each failure it was given first, then each held read in order, which the test
 * resolves when it chooses, and then reads the site account at once.
 */
function createFakeAccountReader({ failures = [], steps = [], reads = [] }: CreateFakeAccountReaderParams = {}) {
  const queue = [...failures];
  const held = [...reads];
  const accounts: ProductAccountId[] = [];
  const accountReader: Pick<SiteAccountReader, 'account'> = {
    account(account) {
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

/**
 * A site's transaction over fakes: `responder` answers the site, Asset Hub plays its script, the creator signs at
 * once and the account reader reads the site account at once, unless the test says otherwise, such as reads it holds
 * open. `steps` names each decode, account read, review and build in the order they happened.
 */
async function startTransactionWith(options: StartTransactionParams, responder: RoundResponder) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const grants = createSiteGrantStore({ idb: createMemorySiteGrantsIdb() });
  for (const grant of options.grants ?? []) {
    await grants.save(grant);
  }
  const steps: string[] = [];
  const chain = createFakeChain({ ...options, steps });
  const signer = createFakeTxSigner({ builds: options.builds });
  const { accountReader, accounts } = createFakeAccountReader({
    failures: options.accountFailures,
    steps,
    reads: options.accountReads,
  });
  const windowFlows: (() => void)[] = [];
  const closed = createDeferred<undefined>();
  const flow = createSiteTransaction({
    request: {
      round: 'r1',
      account: ACCOUNT,
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
      chain: SERVICES.assethub.genesis,
      call: toHex(CALL),
    },
    call: CALL,
    origin: SITE_ORIGIN,
    self: SELF,
    responder,
    grants,
    groups: SITE_GROUPS,
    chain: chain.chain,
    txSigner: signer.txSigner,
    accountReader,
    mainAccount: () => Promise.resolve(MAIN_ACCOUNT),
    startWindowFlow(stored) {
      windowFlows.push(stored);
    },
    now: () => ROUND_NOW,
    randomToken() {
      if (options.tokenFailure !== undefined) {
        throw options.tokenFailure;
      }
      return NEW_SITE_TOKEN;
    },
    close() {
      closed.resolve(undefined);
    },
  });
  const views: SiteScreen['view'][] = [];
  onTestFinished(
    flow.screen.subscribe(({ view }) => {
      views.push(view);
      if (view === 'site-review') {
        steps.push('review');
      }
    }),
  );
  return {
    flow,
    grants,
    chain,
    signedBy: signer.signedBy,
    accounts,
    views,
    steps,
    metrics,
    errors,
    closed: closed.promise,
    /** The window flow the round started says a sign-in is stored. */
    storeSignIn(): void {
      must(windowFlows[0], 'a started window flow')();
    },
    waitForView: (view: SiteScreen['view']) => waitForView(flow.screen, view),
  };
}

/** A site's transaction over fakes, whose responder records what it posts. */
async function startTransaction(options: StartTransactionParams = {}) {
  const { responder, posts } = createRecordingResponder({ origin: SITE_ORIGIN });
  return { ...(await startTransactionWith(options, responder)), posts };
}

/** A round whose Asset Hub cannot be opened, taken through consent and a stored sign-in to its failure. */
async function startFailedOpen() {
  const round = await startTransaction({
    openFailures: [new SiteChainError('unreachable', 'Asset Hub is not reachable')],
  });
  await consentAndStore(round);
  await round.waitForView('site-failed');
  return round;
}

/** Signs on the review once it shows. */
async function signOnReview(round: StartedTransaction): Promise<void> {
  await round.waitForView('site-review');
  round.steps.push('confirm');
  round.flow.confirm();
}

/**
 * The transaction action on Asset Hub `chain`, whose creator signs at once and whose account reader reads the site
 * account at once, unless the test gives its own.
 */
function createTransactionAction(
  chain: SiteChain,
  {
    txSigner = createFakeTxSigner().txSigner,
    accountReader = createFakeAccountReader().accountReader,
  }: { txSigner?: SiteTxSigner; accountReader?: Pick<SiteAccountReader, 'account'> } = {},
) {
  return createSiteTransactionAction({
    origin: SITE_ORIGIN,
    genesis: SERVICES.assethub.genesis,
    call: CALL,
    account: ACCOUNT,
    chain,
    txSigner,
    accountReader,
  });
}

/** The action of a site's transaction. */
type TransactionAction = SiteAction<SiteTransactionResult, 'signed'>;

/** Resolves once `action` shows `view`. */
async function waitForActionView(action: TransactionAction, view: SiteActionScreen['view']): Promise<void> {
  await waitForStatus(action.state, current => current.kind === 'working' && current.screen.view === view);
}

/** Confirms the action's review once it shows. */
async function confirmOnReview(action: TransactionAction): Promise<void> {
  await waitForActionView(action, 'site-review');
  action.confirm();
}

describe('site transaction', () => {
  it("As a user on a site's transaction, I am still asked for consent while the window already opens Asset Hub", async () => {
    // Given a site of no group the main store keeps no grant for
    const round = await startTransaction();

    // When the round shows its consent
    await round.waitForView('consent');

    // Then the window opened the request's Asset Hub once and decoded nothing
    expect(round.chain.opens).toEqual([SERVICES.assethub.genesis]);
    expect(round.chain.record.decoded).toBe(0);
  });

  it("As a user who declines a site's transaction, I leave and the Asset Hub session the round opened is closed once", async () => {
    // Given a site's round on its consent
    const round = await startTransaction();
    await round.waitForView('consent');

    // When the user declines and the window closes
    round.flow.decline();
    await round.closed;
    await round.chain.waitForClosed();

    // Then the session the round opened was closed once and nothing was decoded
    expect(round.chain.record).toMatchObject({ opened: 1, closed: 1, decoded: 0 });
  });

  it('As a user who declines while Asset Hub cannot be opened, I leave and no chain failure is counted or logged', async () => {
    // Given a site's round on its consent, whose Asset Hub cannot be opened
    const round = await startTransaction({
      openFailures: [new SiteChainError('unreachable', 'Asset Hub is not reachable')],
    });
    await round.waitForView('consent');

    // When the user declines and the window closes
    round.flow.decline();
    await round.closed;

    // Then only the refusal is counted and nothing is logged
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'declined' },
    ]);
    expect(round.errors).toEqual([]);
  });

  it('As a site, I ask for my call to be signed and get it signed by my account with nothing sent', async () => {
    // Given a site the main store keeps no grant for, on its review
    const round = await startTransaction();
    await consentAndStore(round);
    await round.waitForView('site-review');
    const review = round.flow.screen.get();

    // When the user signs on the review
    round.steps.push('confirm');
    round.flow.confirm();
    await round.closed;
    const post = getResult(round.posts);

    // Then the call was decoded, the review shown and confirmed, the account read and the transaction built, in that
    // order, for the account the site named, and the site got the signed transaction in lowercase hex with a new token
    expect(round.steps).toEqual(['decode', 'review', 'confirm', 'account', 'create']);
    expect(review).toEqual({
      view: 'site-review',
      origin: SITE_ORIGIN,
      call: DISPLAY,
      account: toDisplayAccount(ACCOUNT),
    });
    expect(post.result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(post.site_token).toBe(NEW_SITE_TOKEN);
    expect(round.signedBy).toEqual([ACCOUNT]);
    expect(round.chain.builtKeys).toEqual([SITE_KEY]);
    expect(await round.grants.list()).toEqual([
      { token: NEW_SITE_TOKEN, origin: SITE_ORIGIN, owner: MAIN_OWNER, firstUsedAt: ROUND_NOW, lastUsedAt: ROUND_NOW },
    ]);
    expect(round.views).toEqual([
      'site-signing',
      'consent',
      'window',
      'site-signing',
      'site-review',
      'site-sharing',
      'site-signing',
      'site-approving',
    ]);
    expect(round.chain.record).toMatchObject({ opened: 1, closed: 1, built: 1 });
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'signed', reason: 'new' }]);
  });

  it('As a user, I see the transaction prepared while its extensions fill and am asked to approve only once the phone is', async () => {
    // Given a chain that is still filling the extensions once the user signed on the review
    const filling = createDeferred<undefined>();
    const filled = createDeferred<undefined>();
    const round = await startTransaction({
      filling() {
        filling.resolve(undefined);
        return filled.promise;
      },
    });
    await consentAndStore(round);
    await signOnReview(round);

    // When the chain fills the extensions, and then the phone is asked
    await filling.promise;
    const whileFilling = round.flow.screen.get();
    filled.resolve(undefined);
    await round.closed;

    // Then the window showed the working view while the extensions filled, and Approve only once the phone was asked
    expect(whileFilling).toEqual({ view: 'site-signing', origin: SITE_ORIGIN, route: 'sign' });
    expect(round.views.slice(-4)).toEqual(['site-review', 'site-sharing', 'site-signing', 'site-approving']);
    expect(getResult(round.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
  });

  it('As a user, I sign the call the review showed, built from that decode and never decoded again', async () => {
    // Given a site's round on its review
    const round = await startTransaction();
    await consentAndStore(round);

    // When the user signs on the review
    await signOnReview(round);
    await round.closed;

    // Then the call was decoded once, for the review, and that decode was built
    expect(round.chain.decodedCalls).toHaveLength(1);
    expect(round.chain.builtCalls).toHaveLength(1);
    expect(round.chain.builtCalls[0]).toBe(round.chain.decodedCalls[0]);
  });

  it('As a user, I reject the transaction on the phone and the site hears I cancelled', async () => {
    // Given a phone on which the user rejects the transaction
    const round = await startTransaction({
      builds: [() => Promise.reject(new SiteTxError('rejected', { tag: 'Cancelled' }))],
    });
    await consentAndStore(round);

    // When the user signs on the review
    await signOnReview(round);
    await round.closed;
    await round.chain.waitForClosed();

    // Then the site hears the round was cancelled, nothing was kept, and the chain was let go
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(round.chain.record).toMatchObject({ opened: 1, closed: 1 });
    expect(await round.grants.list()).toEqual([]);
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'cancelled', reason: 'phone' },
    ]);
  });

  it('As a site, I ask for a transaction the wallet cannot sign and am refused as invalid', async () => {
    // Given a phone that does not support the transaction
    const unsupported = new SiteTxError('unsupported', { tag: 'NotSupported' });
    const round = await startTransaction({ builds: [() => Promise.reject(unsupported)] });
    await consentAndStore(round);

    // When the user signs on the review
    await signOnReview(round);
    await round.closed;

    // Then the site is refused for the transaction, the wallet's error was reported once, and the chain was let go
    expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_invalid' }]);
    expect(round.errors).toHaveLength(1);
    expect(round.errors[0]?.args).toContainEqual(expect.objectContaining({ cause: unsupported }));
    expect(round.chain.record.closed).toBe(1);
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'transaction_invalid' },
    ]);
  });

  it('As a user, I press Try again after a failed build and the window builds again from the chain', async () => {
    // Given a phone whose first build fails
    const round = await startTransaction({
      builds: [() => Promise.reject(new SiteTxError('failed', new Error('No answer')))],
    });
    await consentAndStore(round);
    await signOnReview(round);
    await round.waitForView('site-failed');
    const failed = round.flow.screen.get();

    // When the user tries again and signs once more
    // The retry resolves once the action has no work in flight, here once the review shows.
    await round.flow.retry();
    await signOnReview(round);
    await round.closed;

    // Then the failure offered Try again, the retry opened the chain again and built again, the site account was read
    // once and the window asked to open Polkadot App once, and the site got the signed transaction
    expect(failed).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: true });
    expect(round.views.filter(view => view === 'site-sharing')).toHaveLength(1);
    expect(round.chain.record).toMatchObject({ opened: 2, closed: 2, built: 2 });
    expect(round.accounts).toEqual([ACCOUNT]);
    expect(getResult(round.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'error', reason: 'build' },
      { outcome: 'signed', reason: 'new' },
    ]);
  });

  it('As a user whose chain fails while the transaction is built, I see the failure and can try again', async () => {
    // Given a chain that fails before it asks the creator
    const round = await startTransaction({
      buildFailures: [new SiteChainError('unreachable', 'Asset Hub did not answer')],
    });
    await consentAndStore(round);

    // When the user signs on the review
    await signOnReview(round);
    await round.waitForView('site-failed');

    // Then the failure offers Try again and names the chain, nothing went to the site and the phone was not asked
    expect(round.flow.screen.get()).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: true });
    expect(round.posts).toEqual([]);
    expect(round.signedBy).toEqual([]);
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it('As a user whose chain client fails to close, I sign a transaction and the site still gets it', async () => {
    // Given a chain whose session fails to close
    const closing = new Error('The chain client could not be destroyed');
    const round = await startTransaction({ closeFailure: closing });
    await consentAndStore(round);

    // When the user signs on the review
    await signOnReview(round);
    await round.closed;

    // Then the site got its result once, no failure showed, and the failed close was reported once and counted for the
    // chain
    expect(getResult(round.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(round.posts).toHaveLength(1);
    expect(round.views).not.toContain('site-failed');
    expect(round.errors).toHaveLength(1);
    expect(round.errors[0]?.args).toContainEqual(expect.objectContaining({ cause: closing }));
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'error', reason: 'chain' },
      { outcome: 'signed', reason: 'new' },
    ]);
  });

  it('As a site, I send a call the window cannot decode and am refused before the phone is asked', async () => {
    // Given a chain on which the call does not decode
    const round = await startTransaction({
      decodeFailure: new SiteChainError('undecodable', 'The call does not decode'),
    });

    // When the round runs for the main account
    await consentAndStore(round);
    await round.closed;

    // Then the site is refused as a bad request with nothing reported, and no review showed, no site account was read
    // and nothing was built
    expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(round.errors).toEqual([]);
    expect(round.views).not.toContain('site-review');
    expect(round.accounts).toEqual([]);
    expect(round.signedBy).toEqual([]);
    expect(round.chain.record).toMatchObject({ opened: 1, closed: 1, built: 0 });
  });

  it('As a user whose Asset Hub could not be opened as the round started, I press Try again and the window opens it again', async () => {
    // Given a chain whose first open fails, and a round taken to its failure
    const round = await startFailedOpen();
    const failed = round.flow.screen.get();

    // When the user tries again
    // The retry resolves once the action has no work in flight, here once the review shows.
    await round.flow.retry();

    // Then the failure offered Try again, the window asked for Asset Hub twice, the second open succeeded, and the
    // review shows
    expect(failed).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: true });
    expect(round.chain.opens).toHaveLength(2);
    expect(round.chain.record.opened).toBe(1);
    expect(round.flow.screen.get()).toMatchObject({ view: 'site-review' });
  });

  it("As a user whose window runs on another network than the site's request, I start its transaction and see the failure with no Try again", async () => {
    // Given a chain that refuses the request's Asset Hub as another network's
    const round = await startTransaction({ openFailures: [new SiteChainError('mismatch', 'Another network')] });

    // When the round runs for the main account
    await consentAndStore(round);
    await round.waitForView('site-failed');

    // Then the failure offers no Try again and names the chain, and no site account was read
    expect(round.flow.screen.get()).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: false });
    expect(round.accounts).toEqual([]);
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it('As a user whose site I used before, I sign with no consent and the account the site named is read', async () => {
    // Given a grant for this site and this main account
    const round = await startTransaction({ siteToken: SITE_TOKEN, grants: [createGrant()] });
    await round.waitForView('window');
    round.storeSignIn();

    // When the user signs on the review
    await signOnReview(round);
    await round.closed;

    // Then no consent showed, the account the site named was read, and the site keeps its token
    expect(round.views).not.toContain('consent');
    expect(round.accounts).toEqual([ACCOUNT]);
    expect(getResult(round.posts).site_token).toBeUndefined();
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'signed', reason: 'known' }]);
  });

  it('As a site of a group, I sign with the account I named and the group keeps the grant', async () => {
    // Given a site that asks under a group token, with no grant kept
    const round = await startTransaction({ groupToken: 'my group' });
    await consentAndStore(round);

    // When the user signs on the review
    await signOnReview(round);
    await round.closed;

    // Then the account the site named was read, the site got a new token for a grant of the group, counted as a group's
    expect(round.accounts).toEqual([ACCOUNT]);
    expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
    expect((await round.grants.list()).map(grant => grant.group)).toEqual([
      { registrable: 'my-site.com', token: 'my group', origins: [SITE_ORIGIN] },
    ]);
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'signed', reason: 'group' }]);
  });

  it('As a user whose site account could not be read, I start the transaction and see the failure counted for the account', async () => {
    // Given an account reader whose account read fails
    const round = await startTransaction({ accountFailures: [new SiteAccountReadError({ tag: 'Denied' })] });

    // When the user signs on the review and the read fails
    await consentAndStore(round);
    await signOnReview(round);
    await round.waitForView('site-failed');

    // Then the review showed first, the failure offers Try again and names the account, and the chain was let go with
    // nothing built
    expect(round.views).toContain('site-review');
    expect(round.flow.screen.get()).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: true });
    expect(round.chain.record).toMatchObject({ opened: 1, closed: 1, built: 0 });
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'account' }]);
  });

  it('As a user who confirms the review, I am asked to open Polkadot App while the window reads my site account', async () => {
    // Given a phone that has not answered the site account read yet
    const read = createDeferred<Uint8Array>();
    const round = await startTransaction({ accountReads: [() => read.promise] });
    await consentAndStore(round);

    // When the user signs on the review, and the window asks the phone for the site account
    await signOnReview(round);
    await round.waitForView('site-sharing');
    const sharing = round.flow.screen.get();
    const builtWhileAsking = round.chain.record.built;
    read.resolve(SITE_KEY);
    await round.closed;

    // Then the window asked to open Polkadot App before anything was built, and the site got its signed transaction
    expect(sharing).toEqual({ view: 'site-sharing', origin: SITE_ORIGIN });
    expect(builtWhileAsking).toBe(0);
    expect(getResult(round.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
  });

  it('As a user who is asked to open Polkadot App, I cancel and the site hears I cancelled', async () => {
    // Given a phone that has not answered the site account read yet
    const read = createDeferred<Uint8Array>();
    const round = await startTransaction({ accountReads: [() => read.promise] });
    await consentAndStore(round);
    await signOnReview(round);
    await round.waitForView('site-sharing');

    // When the user cancels, and the phone answers after
    round.flow.cancel();
    read.resolve(SITE_KEY);
    await round.closed;

    // Then the site hears the round was cancelled
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user who is asked to share my account, I reject it on the phone and the site hears I cancelled', async () => {
    // Given a phone on which the user rejects sharing the site account
    const rejection = new SiteAccountRejectedError({ tag: 'Domain', value: { tag: 'V1', value: { tag: 'Rejected' } } });
    const round = await startTransaction({ accountFailures: [rejection] });
    await consentAndStore(round);

    // When the user signs on the review
    await signOnReview(round);
    await round.closed;

    // Then the site hears the round was cancelled, and the phone was never asked to sign
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(round.signedBy).toEqual([]);
    expect(round.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'cancelled', reason: 'phone' },
    ]);
  });

  it('As a user whose site account read failed, I press Try again and see the review again before the phone is asked again', async () => {
    // Given a phone whose first site account read fails
    const round = await startTransaction({ accountFailures: [new SiteAccountReadError({ tag: 'Denied' })] });
    await consentAndStore(round);
    await signOnReview(round);
    await round.waitForView('site-failed');

    // When the user tries again and signs on the review once more
    const retried = round.flow.retry();
    await signOnReview(round);
    await retried;
    await round.closed;
    const afterFailure = round.views.slice(round.views.indexOf('site-failed'));

    // Then the phone was asked twice, the review showed again before the second ask, and the site got its transaction
    expect(round.accounts).toEqual([ACCOUNT, ACCOUNT]);
    expect(getResult(round.posts).result).toEqual({ transaction: SIGNED_TX.toLowerCase() });
    expect(afterFailure.indexOf('site-review')).toBeGreaterThan(-1);
    expect(afterFailure.indexOf('site-review')).toBeLessThan(afterFailure.indexOf('site-sharing'));
  });

  it("As a user, I sign a site's transaction and never hand it my main session, main account or local wallet", async () => {
    // Given a session window's real responder, vetted by the site that opened it, and a main store with a paired
    // session and a local wallet beside it
    const { responder, opener } = createVettedResponder({ origin: SITE_ORIGIN, self: SELF });
    const round = await startTransactionWith({}, responder);
    await consentAndStore(round);

    // When the user signs on the review and the round runs to its result
    await signOnReview(round);
    await round.closed;
    const posted = opener.posted.map(({ message }) => message);
    const sent = writeMessages(posted);

    // Then the site got its signed transaction, and no message it got carries any of them
    expect(sent.filter(message => message.includes('dotli:s:result'))).toHaveLength(1);
    expect(sent.join('\n')).toContain(SIGNED_TX.toLowerCase());
    expect(findLeakedSecrets(posted)).toEqual([]);
  });
});

describe('site transaction action', () => {
  it('As a user who ended the round before its transaction ran, I leave the chain session closed once and nothing is asked of it or the phone', async () => {
    // Given the transaction action of a round that prepared its chain, which opened
    const chain = createFakeChain({});
    const { accountReader, accounts } = createFakeAccountReader();
    const action = createTransactionAction(chain.chain, { accountReader });
    action.prepare();
    await action.await();

    // When the round ends
    action.end();
    await action.await();

    // Then the session closed once, and nothing was decoded or read
    expect(chain.record).toMatchObject({ opened: 1, closed: 1, decoded: 0 });
    expect(accounts).toEqual([]);
  });

  it('As a user who signs in again with another account before Try again, I retry and the site account is read again for the nonce', async () => {
    // Given the transaction action whose first build fails, and an account reader that reads another key for each main account
    const chain = createFakeChain({ buildFailures: [new Error('Asset Hub stopped answering')] });
    const firstKey = new Uint8Array(32).fill(0x31);
    const secondKey = new Uint8Array(32).fill(0x32);
    const keys = [firstKey, secondKey];
    const accounts: ProductAccountId[] = [];
    const action = createTransactionAction(chain.chain, {
      accountReader: {
        account(account) {
          accounts.push(account);
          return Promise.resolve(must(keys.shift(), 'a key for each read'));
        },
      },
    });
    action.start(MAIN_ACCOUNT);
    await confirmOnReview(action);
    await action.await();
    const otherMain: MainAccount = { owner: toHex(hashBlake2b(fromHex(`0x${'b'.repeat(64)}`), 32)), username: null };

    // When the round runs again for the other main account
    action.start(otherMain);
    await confirmOnReview(action);
    await action.await();

    // Then the site account was read again, and the second build filled the nonce from the second key
    expect(action.state.get()).toMatchObject({ kind: 'done' });
    expect(accounts).toEqual([ACCOUNT, ACCOUNT]);
    expect(chain.builtKeys).toEqual([firstKey, secondKey]);
  });

  it('As a user, I cancel while the phone asks me to approve and the chain session closes at once and only once', async () => {
    // Given the transaction action waiting on a phone that has not answered yet
    const chain = createFakeChain({});
    const built = createDeferred<string>();
    const action = createTransactionAction(chain.chain, {
      txSigner: createFakeTxSigner({ builds: [() => built.promise] }).txSigner,
    });
    action.start(MAIN_ACCOUNT);
    await confirmOnReview(action);
    await waitForActionView(action, 'site-approving');

    // When the round ends, and the phone answers after the chain was let go
    action.end();
    await chain.waitForClosed();
    built.resolve(SIGNED_TX);
    await action.await();

    // Then the session closed once, when the round ended, and not again as the run ended
    expect(chain.record).toMatchObject({ opened: 1, closed: 1 });
  });

  it('As a round that ended while the phone was asked for the site account, I build nothing once the phone answers', async () => {
    // Given the transaction action waiting on a phone that has not answered the site account read yet
    const chain = createFakeChain({});
    const read = createDeferred<Uint8Array>();
    const action = createTransactionAction(chain.chain, {
      accountReader: createFakeAccountReader({ reads: [() => read.promise] }).accountReader,
    });
    action.start(MAIN_ACCOUNT);
    await confirmOnReview(action);
    await waitForActionView(action, 'site-sharing');

    // When the round ends, and the phone answers after
    action.end();
    read.resolve(SITE_KEY);
    await action.await();

    // Then the action is idle, and the session closed once with nothing built
    expect(action.state.get()).toEqual({ kind: 'idle' });
    expect(chain.record).toMatchObject({ opened: 1, closed: 1, built: 0 });
  });

  it('As a site whose round already ended, I prepare a transaction and no Asset Hub opens', () => {
    // Given the transaction action of a round that already ended
    const chain = createFakeChain({});
    const action = createTransactionAction(chain.chain);
    action.end();

    // When the action prepares
    action.prepare();

    // Then the chain was not opened
    expect(chain.opens).toEqual([]);
  });

  it('As a user who leaves while Asset Hub still opens, I end the round and its session is closed once it opens', async () => {
    // Given a chain whose open the test holds, and the transaction action of a live round prepared on it
    const opening = createDeferred<undefined>();
    let closes = 0;
    const chain: SiteChain = {
      async open() {
        await opening.promise;
        return {
          decode: () => Promise.reject(new Error('The held chain decodes nothing')),
          create: () => Promise.reject(new Error('The held chain builds nothing')),
          close() {
            closes += 1;
          },
        };
      },
    };
    const action = createTransactionAction(chain);
    action.prepare();

    // When the round ends, and the chain opens after
    action.end();
    opening.resolve(undefined);
    await action.await();
    // A later open on the same chain, by which a second close of the ended round's session would have landed.
    const later = createTransactionAction(chain);
    later.prepare();
    await later.await();

    // Then the ended round's session was closed once
    expect(closes).toBe(1);
  });

  it('As a user, I press confirm before the review shows and nothing reaches the phone', async () => {
    // Given the transaction action whose decode the chain holds
    const decoding = createDeferred<undefined>();
    const decoded = createDeferred<undefined>();
    const chain = createFakeChain({
      decoding() {
        decoding.resolve(undefined);
        return decoded.promise;
      },
    });
    const { accountReader, accounts } = createFakeAccountReader();
    const action = createTransactionAction(chain.chain, { accountReader });
    action.start(MAIN_ACCOUNT);
    await decoding.promise;

    // When the user confirms, and then the decode lands
    action.confirm();
    decoded.resolve(undefined);
    await action.await();

    // Then the review shows, and the site account was not read
    expect(action.state.get()).toMatchObject({ kind: 'working', screen: { view: 'site-review' } });
    expect(accounts).toEqual([]);
  });

  it('As a user, I end the round while the review shows, then press confirm, and nothing reaches the phone', async () => {
    // Given the transaction action on its review
    const chain = createFakeChain({});
    const { accountReader, accounts } = createFakeAccountReader();
    const action = createTransactionAction(chain.chain, { accountReader });
    action.start(MAIN_ACCOUNT);
    await waitForActionView(action, 'site-review');

    // When the round ends, and then the user confirms
    action.end();
    action.confirm();
    await action.await();

    // Then the session closed once, and the site account was not read
    expect(chain.record).toMatchObject({ opened: 1, closed: 1 });
    expect(accounts).toEqual([]);
  });

  it('As an operator, I see a site transaction whose account reader throws at once reported as a defect', async () => {
    // Given the transaction action on its review, whose account reader throws as it is called
    const reports = recordReports({ onFinished: onTestFinished });
    const action = createTransactionAction(createFakeChain({}).chain, {
      accountReader: {
        account() {
          throw new Error('The account reader broke');
        },
      },
    });
    action.start(MAIN_ACCOUNT);
    await waitForActionView(action, 'site-review');

    // When the user confirms the review
    action.confirm();

    // Then the throw was reported as a defect of a transition
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
  });
});
