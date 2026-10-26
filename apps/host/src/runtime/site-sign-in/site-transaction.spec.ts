// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { base64urlnopad } from '@scure/base';
import type { TxCreator, TxEvent, TxInBestBlock } from 'polkadot-api';
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
import type { SessionResult } from '../session-handoff/messages.js';
import { createFakeMessageBus, createFakeWindowHandle } from '../session-handoff/messages.fake.js';
import { openerParty } from '../session-handoff/opener-rule.js';
import { createResponder, type Responder, type ResponderState } from '../session-handoff/responder.js';
import type { DotliAuthState } from '../session/auth-state.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import { encodeSs58 } from './site-assertion.js';
import type { DisplayCall } from './site-call.js';
import { SiteChainError, submitEvents, type SiteChain, type SiteDecodedCall } from './site-chain.js';
import type { SiteActionScreen, SiteRound, SiteScreen } from './site-round.js';
import { parsePublicSuffixList } from './public-suffix-list.js';
import type { SiteGroups } from './site-groups.js';
import { groupDerivationIndex, siteDerivationIndex, SiteSignError, type SiteSigner } from './site-signer.js';
import {
  createSiteTransaction,
  siteTransactionAction,
  type SiteSubmissions,
  type SiteTransactionResult,
} from './site-transaction.js';
import { SiteTxError } from './site-tx-signer.js';

const SELF = 'https://dot.li';
const ORIGIN = 'https://my-site.com';
const NET = NetworkName.PASEO;
const NETWORK = NETWORK_NAME_TO_SERVICES_CONFIG[NET];
const NOW = Date.parse('2026-10-25T15:00:00.000Z');

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(blake2b(fromHex(MAIN_KEY), 32));
const MAIN_UI_STATE = JSON.stringify({ connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot' });
const MAIN_BLOB = 'MAIN-SESSION-BLOB';

const SITE_KEY = new Uint8Array(32).fill(0x22);
const KNOWN_KEY = new Uint8Array(32).fill(0x33);

const CALL = Uint8Array.of(0x0a, 0x03, 0x00, 0x01, 0x02);
const DISPLAY: DisplayCall = {
  name: 'Balances.transfer_keep_alive',
  args: [
    { name: 'dest', value: '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty' },
    { name: 'value', value: '1000000000000' },
  ],
};

/** papi's hashes in uppercase, which the site gets in lowercase. */
const TX_HASH = `0x${'AB'.repeat(32)}`;
const BLOCK_HASH = `0x${'CD'.repeat(32)}`;
/** The signed transaction the fake creator builds, which the site never gets. */
const SIGNED_TX = `0x${'5e'.repeat(80)}`;

const TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(1));
const NEW_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(2));

/** The registrable domains of a few rules of the Public Suffix List, as the window's loaded list gives them. */
const SUFFIXES = parsePublicSuffixList('com\nli\n');
const GROUPS: SiteGroups = { registrable: hostname => Promise.resolve(SUFFIXES.registrable(hostname)) };

const PAIRED: SessionResult = { session: { blob: MAIN_BLOB, uiState: MAIN_UI_STATE }, localWallet: null };
const CONNECTED: DotliAuthState = { tag: 'Connected', session: { connected: true, publicKey: MAIN_KEY } };

const BINDINGS = {} as Parameters<TxCreator>[2];

class FakeInvalidTxError extends Error {}

const broadcasted: TxEvent = { type: 'broadcasted', txHash: TX_HASH };

function inBestBlock(dispatch: Pick<TxInBestBlock, 'ok' | 'dispatchError'>): TxEvent {
  return {
    type: 'inBestBlock',
    txHash: TX_HASH,
    events: [],
    block: { hash: BLOCK_HASH, number: 7, index: 1 },
    ...dispatch,
  } as TxInBestBlock;
}

const INCLUDED = inBestBlock({ ok: true, dispatchError: undefined });
const DISPATCH_FAILED = inBestBlock({
  ok: false,
  dispatchError: { type: 'Module', value: { type: 'Balances', value: { type: 'InsufficientBalance' } } },
});

/** One step of a transaction's watch once built: an event, a failure, or a wait for the test. */
type WatchStep = { event: TxEvent } | { error: unknown } | { wait: Promise<void> };

/** A submission's script: the chain fails before the build, or the watch plays its steps once built. */
type Submission = { chainFails: unknown } | { steps: WatchStep[] };

const SUBMIT_INCLUDED: Submission = { steps: [{ event: broadcasted }, { event: INCLUDED }] };

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
  /** Each submission's script, in order. One that is not scripted is included. */
  submissions?: Submission[];
}

/**
 * Asset Hub over the real event reader: each submission builds with the creator it is given, then plays its script,
 * and stops once unsubscribed, so a stopped watch broadcasts nothing more.
 */
function fakeChain(script: ChainScript) {
  const openFailures = [...(script.openFailures ?? [])];
  const submissions = [...(script.submissions ?? [])];
  const record = { opened: 0, closed: 0, decoded: 0, submitted: 0, broadcast: 0, unsubscribed: 0 };
  // The genesis of each open.
  const opens: string[] = [];
  // Each call the chain decoded, and each it was asked to submit.
  const decodedCalls: SiteDecodedCall[] = [];
  const submittedCalls: SiteDecodedCall[] = [];
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
          if (script.decodeFailure !== undefined) {
            return Promise.reject(script.decodeFailure);
          }
          const decoded: SiteDecodedCall = {
            display: DISPLAY,
            transaction: {
              createSubmitAndWatch: () => {
                throw new Error('The fake chain submits through its session');
              },
            },
          };
          decodedCalls.push(decoded);
          return Promise.resolve(decoded);
        },
        submit: (decoded, creator) =>
          submitEvents(
            {
              subscribe(observer) {
                record.submitted += 1;
                submittedCalls.push(decoded);
                const submission = submissions.shift() ?? SUBMIT_INCLUDED;
                let stopped = false;
                // Read through a call, so a read after an await sees an unsubscribe that happened meanwhile.
                const isStopped = (): boolean => stopped;
                void (async () => {
                  if ('chainFails' in submission) {
                    observer.error(submission.chainFails);
                    return;
                  }
                  try {
                    await creator(payloadOf(CALL), {}, BINDINGS, false);
                  } catch (error) {
                    if (!isStopped()) {
                      observer.error(error);
                    }
                    return;
                  }
                  if (isStopped()) {
                    return;
                  }
                  observer.next({ type: 'created', txHash: TX_HASH });
                  for (const step of submission.steps) {
                    if ('wait' in step) {
                      await step.wait;
                    }
                    if (isStopped()) {
                      return;
                    }
                    if ('event' in step) {
                      if (step.event.type === 'broadcasted') {
                        record.broadcast += 1;
                      }
                      observer.next(step.event);
                    } else if ('error' in step) {
                      observer.error(step.error);
                    }
                  }
                })();
                return {
                  unsubscribe() {
                    stopped = true;
                    record.unsubscribed += 1;
                  },
                };
              },
            },
            error => error instanceof FakeInvalidTxError,
          ),
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
  return { chain, record, opens, decodedCalls, submittedCalls, closed: () => allClosed.promise };
}

/** A creator per main key that builds at once, unless the test gave it what each build answers. */
function fakeTxSigner(builds: (() => Promise<string>)[] = []) {
  const queue = [...builds];
  const mainKeys: Uint8Array[] = [];
  return {
    mainKeys,
    txSigner: {
      creator:
        (mainPublicKey: Uint8Array): TxCreator =>
        () => {
          mainKeys.push(mainPublicKey);
          const build = queue.shift();
          return build === undefined ? Promise.resolve(SIGNED_TX) : build();
        },
    },
  };
}

/** A signer that reads the site account at once, after it answers with each failure it was given. */
function fakeSigner(failures: Error[] = []) {
  const queue = [...failures];
  const accounts: string[] = [];
  const signer: Pick<SiteSigner, 'account'> = {
    account: index => {
      accounts.push(index);
      const failure = queue.shift();
      return failure === undefined ? Promise.resolve(SITE_KEY) : Promise.reject(failure);
    },
  };
  return { signer, accounts };
}

/** Submission marks kept in memory, which the window keeps in the tab's storage. */
function memorySubmissions(...rounds: string[]): SiteSubmissions {
  const marked = new Set(rounds);
  return {
    has: round => marked.has(round),
    mark: round => {
      marked.add(round);
    },
  };
}

/** What the round hands the action: the main account, a site account never used, and a confirm already given. */
function actionInput(show: (screen: SiteActionScreen) => void = () => undefined) {
  return {
    main: { owner: OWNER, username: null, publicKey: fromHex(MAIN_KEY) },
    index: siteDerivationIndex(ORIGIN),
    knownKey: null,
    show,
    confirmed: () => Promise.resolve(),
    signal: new AbortController().signal,
  };
}

function grantOf(): SiteGrant {
  return {
    token: TOKEN,
    origin: ORIGIN,
    publicKey: toHex(KNOWN_KEY),
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
 * A site's transaction over fakes: `responder` answers the site, Asset Hub plays its script, the creator builds at
 * once and the signer reads the site account at once, unless the test says otherwise.
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
  const chain = fakeChain(options);
  const tx = fakeTxSigner(options.builds);
  const { signer, accounts } = fakeSigner(options.accountFailures);
  const windowFlows: ((result: SessionResult) => void)[] = [];
  const closed = deferred<undefined>();
  const flow = createSiteTransaction({
    request: {
      round: 'r1',
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
      chain: NETWORK.assethub.genesis,
      call: toHex(CALL),
    },
    call: CALL,
    submitted: memorySubmissions(),
    origin: ORIGIN,
    self: SELF,
    responder,
    grants,
    groups: GROUPS,
    chain: chain.chain,
    txSigner: tx.txSigner,
    signer,
    auth: createSyncStore<DotliAuthState>('testSiteAuth', CONNECTED),
    readUiCache: () => Promise.resolve(MAIN_UI_STATE),
    startWindowFlow: deliver => {
      windowFlows.push(deliver);
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
    views.push(flow.screen.get().view);
  });
  return {
    flow,
    grants,
    chain,
    mainKeys: tx.mainKeys,
    accounts,
    views,
    metrics,
    errors,
    closed: closed.promise,
    /** Hands over the paired main session through the window flow the round started. */
    deliver: () => {
      must(windowFlows[0], 'a started window flow')(PAIRED);
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

/** Consents on the consent view and hands over the paired main session. */
async function consentAndDeliver(h: Harness): Promise<void> {
  await h.until('consent');
  await h.flow.consent();
  h.deliver();
}

/** Signs on the review once it shows. */
async function sign(flow: SiteRound, h: Harness): Promise<void> {
  await h.until('site-review');
  flow.confirm();
}

describe('site transaction', () => {
  it("As a user, I review a site's call, sign it on the phone and the site gets the included transaction", async () => {
    // Given a site the main store keeps no grant for, and a chain that includes the transaction
    const h = await harness();
    await consentAndDeliver(h);
    await h.until('site-review');
    const review = h.flow.screen.get();

    // When the user signs on the review
    h.flow.confirm();
    await h.closed;

    // Then the review showed the decoded call, the site got the result in lowercase hex with a new token, once
    expect(review).toEqual({ view: 'site-review', origin: ORIGIN, call: DISPLAY });
    const post = resultOf(h.posts);
    expect(post.result).toEqual({
      tx_hash: TX_HASH.toLowerCase(),
      status: 'included',
      block_hash: BLOCK_HASH.toLowerCase(),
    });
    expect(post.site_token).toBe(NEW_TOKEN);
    expect(h.mainKeys).toEqual([fromHex(MAIN_KEY)]);
    expect(h.accounts).toEqual([siteDerivationIndex(ORIGIN)]);
    expect(await h.grants.list()).toEqual([
      { token: NEW_TOKEN, origin: ORIGIN, publicKey: toHex(SITE_KEY), owner: OWNER, firstUsedAt: NOW, lastUsedAt: NOW },
    ]);
    expect(h.views).toEqual([
      'site-signing',
      'consent',
      'window',
      'site-signing',
      'site-review',
      'site-submitting',
      'site-submitting',
    ]);
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1, submitted: 1, broadcast: 1 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'included', reason: 'new' }]);
  });

  it('As a user, I sign the call the review showed, submitted from that decode and never decoded again', async () => {
    // Given a site's round on a chain that includes the transaction
    const h = await harness();
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the call was decoded once, for the review, and that decode was submitted
    expect(h.chain.decodedCalls).toHaveLength(1);
    expect(h.chain.submittedCalls).toHaveLength(1);
    expect(h.chain.submittedCalls[0]).toBe(h.chain.decodedCalls[0]);
  });

  it('As a user, I am told the transaction is being sent once the chain has it', async () => {
    // Given a chain that holds the transaction after its broadcast until the test lets it in
    const included = deferred<undefined>();
    const h = await harness({
      submissions: [{ steps: [{ event: broadcasted }, { wait: included.promise }, { event: INCLUDED }] }],
    });
    await consentAndDeliver(h);
    await sign(h.flow, h);

    // When the chain reports the broadcast
    await untilStatus(storeStatus(h.flow.screen), shown => shown.view === 'site-submitting' && shown.sent);
    const sending = h.flow.screen.get();
    included.resolve(undefined);
    await h.closed;

    // Then the window said the transaction is being sent, then the site got its result
    expect(sending).toEqual({ view: 'site-submitting', origin: ORIGIN, sent: true });
    expect(resultOf(h.posts).result.status).toBe('included');
  });

  it('As a site, I get a failed transaction with its dispatch error', async () => {
    // Given a chain whose best block holds the transaction with a dispatch error
    const h = await harness({ submissions: [{ steps: [{ event: broadcasted }, { event: DISPATCH_FAILED }] }] });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the site gets the failed status with the error's path, and the round counts it as failed
    expect(resultOf(h.posts).result).toEqual({
      tx_hash: TX_HASH.toLowerCase(),
      status: 'failed',
      block_hash: BLOCK_HASH.toLowerCase(),
      error: 'Module.Balances.InsufficientBalance',
    });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'failed', reason: 'new' }]);
  });

  it('As a user who rejects the transaction on the phone, I cancel the round and nothing is broadcast', async () => {
    // Given a phone on which the user rejects the transaction
    const h = await harness({ builds: [() => Promise.reject(new SiteTxError('rejected', { tag: 'Cancelled' }))] });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;
    await h.chain.closed();

    // Then the site hears the round was cancelled, nothing was broadcast or kept, and the chain was let go
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1, broadcast: 0 });
    expect(await h.grants.list()).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'cancelled', reason: 'phone' }]);
  });

  it('As a user who cancels while the phone asks me to approve, I end the watch and nothing is broadcast', async () => {
    // Given a phone that has not answered yet
    const built = deferred<string>();
    const h = await harness({ builds: [() => built.promise] });
    await consentAndDeliver(h);
    await sign(h.flow, h);
    await h.until('site-submitting');

    // When the user cancels, and the phone answers after it
    h.flow.cancel();
    await h.chain.closed();
    built.resolve(SIGNED_TX);
    await h.closed;

    // Then the site hears the round was cancelled, the watch was stopped and nothing was broadcast
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.chain.record).toMatchObject({ unsubscribed: 1, broadcast: 0, closed: 1 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user who cancels after the transaction was sent, the site hears transaction_unknown, not cancelled', async () => {
    // Given a chain that holds the transaction after its broadcast
    const included = deferred<undefined>();
    const h = await harness({
      submissions: [{ steps: [{ event: broadcasted }, { wait: included.promise }, { event: INCLUDED }] }],
    });
    await consentAndDeliver(h);
    await sign(h.flow, h);
    await untilStatus(storeStatus(h.flow.screen), shown => shown.view === 'site-submitting' && shown.sent);

    // When the user cancels, and the chain then includes the transaction
    h.flow.cancel();
    await h.chain.closed();
    included.resolve(undefined);
    await h.closed;

    // Then the site hears its outcome is unknown, once, the watch was stopped and the chain was let go
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_unknown' }]);
    expect(h.chain.record).toMatchObject({ submitted: 1, broadcast: 1, unsubscribed: 1, closed: 1 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'transaction_unknown' },
    ]);
  });

  it('As a site whose transaction the chain refuses, I am refused with transaction_invalid', async () => {
    // Given a chain that refuses the transaction before any block
    const invalid = new FakeInvalidTxError('Invalid');
    const h = await harness({ submissions: [{ steps: [{ error: invalid }] }] });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the site is refused for the transaction, and the chain's error was reported once
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_invalid' }]);
    expect(h.chain.record.closed).toBe(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.args).toContainEqual(expect.objectContaining({ cause: invalid }));
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'transaction_invalid' },
    ]);
  });

  it('As a site whose transaction was lost after its broadcast, I am refused with transaction_unknown and it is never sent again', async () => {
    // Given a chain whose watch fails after the broadcast
    const dropped = new Error('The connection dropped');
    const h = await harness({ submissions: [{ steps: [{ event: broadcasted }, { error: dropped }] }] });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the site is refused as unknown, the lost watch was reported once, no Try again showed and the transaction
    // was submitted once
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_unknown' }]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.args).toContainEqual(expect.objectContaining({ cause: dropped }));
    expect(h.views).not.toContain('site-failed');
    expect(h.chain.record).toMatchObject({ submitted: 1, closed: 1 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'refused', reason: 'transaction_unknown' },
    ]);
  });

  it('As a user whose transaction was lost before its broadcast, I see it failed and can try again', async () => {
    // Given a chain whose watch fails before the broadcast
    const h = await harness({ submissions: [{ steps: [{ error: new Error('The connection dropped') }] }] });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.until('site-failed');

    // Then the failure offers Try again and names the submission, with nothing sent
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.posts).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'submit' }]);
  });

  it('As a user whose chain client fails to close after the transaction was included, the site still gets it and Try again submits nothing', async () => {
    // Given a chain that includes the transaction and whose session then fails to close
    const closing = new Error('The chain client could not be destroyed');
    const h = await harness({ closeFailure: closing });
    await consentAndDeliver(h);
    await sign(h.flow, h);
    await h.closed;

    // When the user presses Try again
    await h.flow.retry();

    // Then the site got its result once, the transaction was submitted once, and the failed close was reported once
    // and counted for the chain
    expect(resultOf(h.posts).result.status).toBe('included');
    expect(h.posts).toHaveLength(1);
    expect(h.views).not.toContain('site-failed');
    expect(h.chain.record).toMatchObject({ opened: 1, submitted: 1, broadcast: 1, closed: 1 });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.args).toContainEqual(expect.objectContaining({ cause: closing }));
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'error', reason: 'chain' },
      { outcome: 'included', reason: 'new' },
    ]);
  });

  it('As a user whose round failed after its transaction was included, Try again refuses the site with transaction_unknown and submits nothing', async () => {
    // Given a chain that includes the transaction, and a round that fails before it answers
    const h = await harness({ tokenFailure: new Error('No randomness') });
    await consentAndDeliver(h);
    await sign(h.flow, h);
    await h.until('site-failed');

    // When the user presses Try again
    await h.flow.retry();
    await h.closed;

    // Then the site hears its outcome is unknown, once, and the transaction was submitted once on one chain session
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_unknown' }]);
    expect(h.chain.record).toMatchObject({ opened: 1, submitted: 1, broadcast: 1, closed: 1 });
    expect(h.mainKeys).toHaveLength(1);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'error', reason: 'action' },
      { outcome: 'refused', reason: 'transaction_unknown' },
    ]);
  });

  it('As a site, I have my call decoded and submitted on the Asset Hub my request named', async () => {
    // Given a site's request checked against its network's Asset Hub
    const h = await harness();
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the window opened that Asset Hub
    expect(h.chain.opens).toEqual([NETWORK.assethub.genesis]);
  });

  it('As a site whose call does not decode, I am refused with bad_request before any review or account read', async () => {
    // Given a chain on which the call does not decode
    const h = await harness({ decodeFailure: new SiteChainError('undecodable', 'The call does not decode') });

    // When the round runs for the paired session
    await consentAndDeliver(h);
    await h.closed;

    // Then the site is refused as a bad request with nothing reported, and no review showed and no site account was read
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(h.errors).toEqual([]);
    expect(h.views).not.toContain('site-review');
    expect(h.accounts).toEqual([]);
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1 });
  });

  it('As a user whose chain cannot be reached, I see the failure and can try again', async () => {
    // Given a chain that cannot be opened
    const h = await harness({ openFailures: [new SiteChainError('unreachable', 'Asset Hub is not reachable')] });

    // When the round runs for the paired session
    await consentAndDeliver(h);
    await h.until('site-failed');

    // Then the failure offers Try again and names the chain, and no site account was read
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.accounts).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it("As a user whose window runs on another network than the site's request, I see the failure with no Try again", async () => {
    // Given a chain that refuses the request's Asset Hub as another network's
    const h = await harness({ openFailures: [new SiteChainError('mismatch', 'Another network')] });

    // When the round runs for the paired session
    await consentAndDeliver(h);
    await h.until('site-failed');

    // Then the failure offers no Try again and names the chain, and no site account was read
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: false });
    expect(h.accounts).toEqual([]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it('As a user whose chain dropped before the build, I try again and the site account is not read twice', async () => {
    // Given a chain that fails its first submission before the build
    const h = await harness({
      submissions: [{ chainFails: new SiteChainError('unreachable', 'Asset Hub did not answer') }, SUBMIT_INCLUDED],
    });
    await consentAndDeliver(h);
    await sign(h.flow, h);
    await h.until('site-failed');
    const failed = h.flow.screen.get();

    // When the user tries again and signs once more
    // The retry runs until the round ends, so the user signs while it runs.
    const retried = h.flow.retry();
    await sign(h.flow, h);
    await retried;
    await h.closed;

    // Then the failure offered Try again, the retry sent the result, the site account was read once and both chain
    // sessions were let go
    expect(failed).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(resultOf(h.posts).result.status).toBe('included');
    expect(h.accounts).toEqual([siteDerivationIndex(ORIGIN)]);
    expect(h.chain.record).toMatchObject({ opened: 2, closed: 2 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([
      { outcome: 'error', reason: 'chain' },
      { outcome: 'included', reason: 'new' },
    ]);
  });

  it('As a user whose site I used before, I sign with no consent and no site account read', async () => {
    // Given a grant for this site and this main account
    const h = await harness({ siteToken: TOKEN, grants: [grantOf()] });
    await h.until('window');
    h.deliver();

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then no consent showed, no account was read, and the site keeps its token
    expect(h.views).not.toContain('consent');
    expect(h.accounts).toEqual([]);
    expect(resultOf(h.posts).site_token).toBeUndefined();
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'included', reason: 'known' }]);
  });

  it('As a site of a group, I sign with the group account and the group keeps the grant', async () => {
    // Given a site that asks under a group token, with no grant kept
    const h = await harness({ groupToken: 'my group' });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the group's account was read, the site got a new token for a grant of the group, counted as a group's
    expect(h.accounts).toEqual([groupDerivationIndex('my-site.com', 'my group')]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
    expect((await h.grants.list()).map(grant => grant.group)).toEqual([
      { registrable: 'my-site.com', token: 'my group', origins: [ORIGIN] },
    ]);
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'included', reason: 'group' }]);
  });

  it('As a site whose transaction the phone does not support, I am refused with transaction_invalid', async () => {
    // Given a phone that does not support the request
    const h = await harness({
      builds: [() => Promise.reject(new SiteTxError('unsupported', { tag: 'NotSupported' }))],
    });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.closed;

    // Then the site is refused for the transaction and nothing was broadcast
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_invalid' }]);
    expect(h.chain.record.broadcast).toBe(0);
  });

  it('As a user whose build failed, I see it failed and can try again', async () => {
    // Given a phone whose build fails
    const h = await harness({ builds: [() => Promise.reject(new SiteTxError('failed', new Error('No answer')))] });
    await consentAndDeliver(h);

    // When the user signs on the review
    await sign(h.flow, h);
    await h.until('site-failed');

    // Then the failure offers Try again and names the build
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'build' }]);
  });

  it('As a user whose site account could not be read, I see the failure counted for the account', async () => {
    // Given a signer whose account read fails
    const h = await harness({ accountFailures: [new SiteSignError('account', { tag: 'Denied' })] });

    // When the round runs for the paired session
    await consentAndDeliver(h);
    await h.until('site-failed');

    // Then the failure offers Try again and names the account, and the chain was let go
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.chain.record).toMatchObject({ opened: 1, closed: 1, submitted: 0 });
    expect(h.metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'error', reason: 'account' }]);
  });

  it('As a user, I never hand a site my main session, main account or signed transaction', async () => {
    // Given a session window's real responder, vetted by the site that opened it
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
    await consentAndDeliver(h);

    // When the user signs on the review and the round runs to its result
    await sign(h.flow, h);
    await h.closed;

    // Then the site got its result, and no message it got carries any of them
    // A byte array writes as its hex, since JSON would write it as an object of indices.
    const sent = opener.posted.map(({ message }) =>
      JSON.stringify(message, (_key, value: unknown) => (value instanceof Uint8Array ? toHex(value) : value)),
    );
    const secrets = [MAIN_BLOB, 'a'.repeat(64), encodeSs58(fromHex(MAIN_KEY), NETWORK.ss58Prefix), SIGNED_TX.slice(2)];
    expect(sent.filter(message => message.includes('dotli:s:result'))).toHaveLength(1);
    expect(sent.join('\n')).toContain(TX_HASH.toLowerCase());
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
    const { signer, accounts } = fakeSigner();
    const action = siteTransactionAction({
      round: 'r1',
      submitted: memorySubmissions(),
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      signer,
    });
    const shown: string[] = [];

    // When the action runs
    const refusal: unknown = await action
      .run({
        main: { owner: OWNER, username: null, publicKey: fromHex(MAIN_KEY) },
        index: siteDerivationIndex(ORIGIN),
        knownKey: null,
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

  it('As a site, I am refused with transaction_unknown when the action runs again after it submitted, and it never submits again', async () => {
    // Given the transaction action that already submitted and included the transaction
    const chain = fakeChain({});
    const action = siteTransactionAction({
      round: 'r1',
      submitted: memorySubmissions(),
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      signer: fakeSigner().signer,
    });
    const input = {
      main: { owner: OWNER, username: null, publicKey: fromHex(MAIN_KEY) },
      index: siteDerivationIndex(ORIGIN),
      knownKey: null,
      show: () => undefined,
      confirmed: () => Promise.resolve(),
      signal: new AbortController().signal,
    };
    const first = await action.run(input);

    // When the action runs again
    const refusal: unknown = await action.run(input).catch((caught: unknown) => caught);

    // Then the first run was included, the second refuses with transaction_unknown, and one chain session submitted once
    expect(first.result.status).toBe('included');
    expect(refusal).toMatchObject({ name: 'SiteRoundRefusal', reason: 'transaction_unknown' });
    expect(chain.record).toMatchObject({ opened: 1, submitted: 1, broadcast: 1, closed: 1 });
  });

  it('As a site whose window reloaded after it submitted my transaction, I am refused with transaction_unknown before any decode or phone request', async () => {
    // Given the marks of a window whose action submitted the round's transaction before the window reloaded
    const submitted = memorySubmissions();
    await siteTransactionAction({
      round: 'r1',
      submitted,
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      chain: fakeChain({}).chain,
      txSigner: fakeTxSigner().txSigner,
      signer: fakeSigner().signer,
    }).run(actionInput());
    const chain = fakeChain({});
    const tx = fakeTxSigner();
    const { signer, accounts } = fakeSigner();
    const action = siteTransactionAction({
      round: 'r1',
      submitted,
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      chain: chain.chain,
      txSigner: tx.txSigner,
      signer,
    });

    // When the reloaded window's action runs for the same round
    const refusal: unknown = await action.run(actionInput()).catch((caught: unknown) => caught);

    // Then it refuses with transaction_unknown, a Cancel would say the same, and it reached no chain, account or build
    expect(refusal).toMatchObject({ name: 'SiteRoundRefusal', reason: 'transaction_unknown' });
    expect(action.cancelAs?.()).toBe('transaction_unknown');
    expect(chain.record).toMatchObject({ opened: 0, decoded: 0, submitted: 0 });
    expect(accounts).toEqual([]);
    expect(tx.mainKeys).toEqual([]);
  });

  it('As a site, I have my transaction submitted when only another round of the window was submitted', async () => {
    // Given the marks of a window that submitted another round's transaction
    const submitted = memorySubmissions('r0');
    const chain = fakeChain({});
    const action = siteTransactionAction({
      round: 'r1',
      submitted,
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      signer: fakeSigner().signer,
    });

    // When the action runs for its own round
    const { result } = await action.run(actionInput());

    // Then its transaction was submitted and included, and its own round is marked too
    expect(result.status).toBe('included');
    expect(chain.record).toMatchObject({ submitted: 1, broadcast: 1 });
    expect(submitted.has('r1')).toBe(true);
  });

  it('As a user, I have my round marked submitted as soon as the chain has the transaction, before it is included', async () => {
    // Given a chain that holds the transaction after its broadcast until the test lets it in
    const included = deferred<undefined>();
    const chain = fakeChain({
      submissions: [{ steps: [{ event: broadcasted }, { wait: included.promise }, { event: INCLUDED }] }],
    });
    const submitted = memorySubmissions();
    const action = siteTransactionAction({
      round: 'r1',
      submitted,
      origin: ORIGIN,
      genesis: NETWORK.assethub.genesis,
      call: CALL,
      chain: chain.chain,
      txSigner: fakeTxSigner().txSigner,
      signer: fakeSigner().signer,
    });
    // Whether the round was marked as each submitting view showed, and once the chain had it.
    const marks: boolean[] = [];
    const sent = deferred<undefined>();

    // When the action runs until the chain reports the broadcast
    const running = action.run(
      actionInput(screen => {
        if (screen.view === 'site-submitting') {
          marks.push(submitted.has('r1'));
          if (screen.sent) {
            sent.resolve(undefined);
          }
        }
      }),
    );
    await sent.promise;
    const markedBeforeIncluded = submitted.has('r1');
    included.resolve(undefined);
    await running;

    // Then the round was unmarked before the broadcast, and marked by the time the window said it was sent
    expect(marks).toEqual([false, true]);
    expect(markedBeforeIncluded).toBe(true);
  });
});
