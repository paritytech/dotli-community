// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { base64urlnopad } from '@scure/base';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
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
import type { SessionResult } from '../session-handoff/messages.js';
import type { ResponderState } from '../session-handoff/responder.js';
import type { RefusalReason } from '../session-handoff/session-protocol.js';
import { createChanges } from '../../testing/changes.js';
import type { DotliAuthState } from '../session/auth-state.js';
import {
  createSiteRound,
  forgetsUnsentGrant,
  SiteRoundFailure,
  SiteRoundRefusal,
  SiteRoundRejected,
  type MainAccount,
  type SiteAction,
  type SiteRound,
  type SiteRoundDeps,
  type SiteScreen,
} from './site-round.js';
import { parsePublicSuffixList } from './public-suffix-list.js';
import type { SiteGroups } from './site-groups.js';
import { groupDerivationIndex, siteDerivationIndex } from './site-signer.js';

const ORIGIN = 'https://my-site.com';
const SELF = 'https://dot.li';
const NOW = Date.parse('2026-10-23T15:00:00.000Z');
const STATEMENT = 'Optional statement from the site.';
const METRIC = 'test.site_round';

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(blake2b(fromHex(MAIN_KEY), 32));
const MAIN_UI_STATE = JSON.stringify({
  connected: true,
  publicKey: MAIN_KEY,
  liteUsername: 'alice.01',
  fullUsername: 'alice.dot',
});
const MAIN_BLOB = 'MAIN-SESSION-BLOB';
const WALLET_ENTROPY = new Uint8Array(16).fill(0x5c);

const SITE_KEY = new Uint8Array(32).fill(0x22);
const KNOWN_KEY = new Uint8Array(32).fill(0x33);

const TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(1));
const NEW_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(2));
const GROUP_TOKEN = 'my group';

/** A few rules of the Public Suffix List, a private one included. */
const SUFFIXES = parsePublicSuffixList('com\nio\ngithub.io\nli\nbg\n0.bg\n');

/** The registrable domains of {@link SUFFIXES}, as the window's loaded list gives them. */
const GROUPS: SiteGroups = { registrable: hostname => Promise.resolve(SUFFIXES.registrable(hostname)) };

/** What the fake action answers the site. */
interface FakeResult {
  done: string;
}

const RESULT: FakeResult = { done: 'the action ran' };

/** What the window flow hands over for a main store that holds a paired session. */
const PAIRED: SessionResult = { session: { blob: MAIN_BLOB, uiState: MAIN_UI_STATE }, localWallet: null };

const CONNECTED: DotliAuthState = { tag: 'Connected', session: { connected: true, publicKey: MAIN_KEY } };

const MAIN: MainAccount = {
  owner: OWNER,
  username: { name: 'alice.dot', kind: 'full' },
  publicKey: fromHex(MAIN_KEY),
};

function grantOf(fields: Partial<SiteGrant> = {}): SiteGrant {
  return {
    token: TOKEN,
    origin: ORIGIN,
    publicKey: toHex(KNOWN_KEY),
    owner: OWNER,
    firstUsedAt: NOW - 1000,
    lastUsedAt: NOW - 1000,
    ...fields,
  };
}

/** One message the window posted to its opener. */
type Post =
  | { type: 'dotli:s:result'; result: unknown; site_token?: string }
  | { type: 'dotli:s:refused'; reason: string }
  | { type: 'dotli:s:cancelled' };

type RunInput = Parameters<SiteAction<FakeResult>['run']>[0];

/** One run of the action, which the test may finish itself. */
interface ActionRun {
  input: RunInput;
  /** Ends the run with its result, or with `error`. */
  finish: (error?: Error) => void;
}

interface HarnessOptions {
  /** The site's origin, {@link ORIGIN} by default. */
  origin?: string;
  /** The window's own origin, {@link SELF} by default. */
  self?: string;
  siteToken?: string | null;
  groupToken?: string | null;
  /** The registrable domains the round judges a group by, {@link GROUPS} by default. */
  groups?: SiteGroups;
  /** A grants store another round shares, in place of a new one. */
  store?: SiteGrantStore;
  /** The token a new grant gets, {@link NEW_TOKEN} by default. */
  newToken?: string;
  /** Grants the main store keeps before the round. */
  grants?: SiteGrant[];
  auth?: DotliAuthState;
  /** What the main store's account cache holds, read on a Retry. */
  uiCache?: string | null;
  /** Failures the action throws, one per run, before it runs to its result. */
  failures?: Error[];
  /** Whether each run waits for the test to finish it. */
  held?: boolean;
  /** Held until it settles before a grant is saved, and a rejection fails the save. */
  saveGate?: Promise<void>;
  /** Whether saving a grant fails. */
  saveFails?: boolean;
  /** Whether the first start of the window flow throws. */
  windowFlowFails?: boolean;
  /** Whether reading a grant fails. */
  readFails?: boolean;
  /** The refusal the action asks a Cancel to answer with. */
  cancelAs?: RefusalReason;
}

/**
 * A site's round over fakes: a responder that records what it posts, ends its round on its first terminal call and
 * holds a result sent while it waits to be vetted again, an in-memory grants store, an action the test scripts, and a
 * window flow the test delivers through.
 */
async function harness(options: HarnessOptions = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  // Notified when an action runs, a save starts, a forget ends, the round subscribes to the session or a result is
  // held, which a test waits on.
  const changes = createChanges();
  const posts: Post[] = [];
  const origin = options.origin ?? ORIGIN;
  const vetted: ResponderState = { kind: 'vetted', origin, party: 'third' };
  const round = createSyncStore<ResponderState>('testSiteRoundResponder', vetted);
  // A result sent while the window waits to be vetted again, which goes out with that vetting.
  let held: Post | null = null;
  const end = (post: Post, state: ResponderState): void => {
    const { kind } = round.get();
    if (kind === 'answered' || kind === 'refused') {
      return;
    }
    held = null;
    posts.push(post);
    round.set(state);
  };
  const responder: SiteRoundDeps<FakeResult>['responder'] = {
    state: round.get,
    subscribe: listener =>
      round.subscribe(() => {
        listener(round.get());
      }),
    send: (result, siteToken) => {
      const post: Post = {
        type: 'dotli:s:result',
        result,
        ...(siteToken === undefined ? {} : { site_token: siteToken }),
      };
      if (round.get().kind === 'connecting') {
        held = post;
        changes.notify();
        return;
      }
      end(post, { kind: 'answered' });
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
  let saving = 0;
  let forgotten = 0;
  let authWaits = 0;
  /** Counts a save, then holds it at the gate and fails it when the test says so. */
  const gateSave = async (): Promise<void> => {
    saving += 1;
    changes.notify();
    await options.saveGate;
    if (options.saveFails === true) {
      throw new Error('The grants database is full');
    }
  };
  const grants: SiteGrantStore = {
    ...stored,
    save: async grant => {
      await gateSave();
      await stored.save(grant);
    },
    saveGroup: async grant => {
      await gateSave();
      return stored.saveGroup(grant);
    },
    forget: async token => {
      await stored.forget(token);
      forgotten += 1;
      changes.notify();
    },
    ...(options.readFails === true ? { read: () => Promise.reject(new Error('The grants database is closed')) } : {}),
  };
  const auth = createSyncStore<DotliAuthState>('testSiteRoundAuth', options.auth ?? CONNECTED);
  const watchedAuth: ReadableStore<DotliAuthState> = {
    get: auth.get,
    initial: auth.initial,
    subscribe: listener => {
      authWaits += 1;
      changes.notify();
      return auth.subscribe(listener);
    },
  };
  const failures = [...(options.failures ?? [])];
  const runs: (ActionRun & { auth: DotliAuthState['tag'] })[] = [];
  const action: SiteAction<FakeResult> = {
    route: 'sign',
    outcome: () => 'granted',
    ...(options.cancelAs === undefined ? {} : { cancelAs: () => options.cancelAs ?? null }),
    run: input => {
      const failure = failures.shift();
      const done = deferred<{ result: FakeResult; publicKey: Uint8Array }>();
      const finish = (error?: Error): void => {
        if (error === undefined) {
          done.resolve({ result: RESULT, publicKey: input.knownKey ?? SITE_KEY });
        } else {
          done.reject(error);
        }
      };
      runs.push({ input, finish, auth: auth.get().tag });
      changes.notify();
      if (failure !== undefined) {
        finish(failure);
      } else if (options.held !== true) {
        finish();
      }
      return done.promise;
    },
  };
  let windowFlowFails = options.windowFlowFails === true;
  const windowFlows: { deliver: (result: SessionResult) => void; close: () => void }[] = [];
  const closed = deferred<undefined>();
  let closes = 0;
  const flow = createSiteRound({
    request: {
      round: 'r1',
      statement: STATEMENT,
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
    },
    origin,
    self: options.self ?? SELF,
    responder,
    grants,
    groups: options.groups ?? GROUPS,
    auth: watchedAuth,
    readUiCache: () => Promise.resolve(options.uiCache === undefined ? MAIN_UI_STATE : options.uiCache),
    startWindowFlow: (deliver, close) => {
      if (windowFlowFails) {
        windowFlowFails = false;
        throw new Error('The window flow could not start');
      }
      windowFlows.push({ deliver, close });
    },
    now: () => NOW,
    randomToken: () => options.newToken ?? NEW_TOKEN,
    close: () => {
      closes += 1;
      closed.resolve(undefined);
    },
    action,
    metric: METRIC,
  });
  const screens: SiteScreen[] = [flow.screen.get()];
  flow.screen.subscribe(() => {
    screens.push(flow.screen.get());
  });
  return {
    flow,
    posts,
    stored,
    auth,
    runs,
    screens,
    views: () => screens.map(shown => shown.view),
    metrics,
    errors,
    closed: closed.promise,
    closes: () => closes,
    /** The window flow the round started, which the test delivers through. */
    windowFlow: () => must(windowFlows[0], 'a started window flow'),
    windowFlows,
    /** Resolves once the screen shows `view`. */
    until: (view: SiteScreen['view']) => untilView(flow.screen, view),
    /** Resolves with the action's run once it ran `count` times. */
    started: async (count = 1): Promise<ActionRun> => {
      await changes.until(() => runs.length >= count);
      return must(runs[count - 1], 'a run of the action');
    },
    /** Resolves once a grant save started. */
    untilSaving: () => changes.until(() => saving > 0),
    /** Resolves once a grant was forgotten. */
    untilForgotten: () => changes.until(() => forgotten > 0),
    /** Resolves once the round waits on the session's state. */
    untilAuthWaited: () => changes.until(() => authWaits > 0),
    /** Resolves once a result waits for the window to be vetted again. */
    untilHeld: () => changes.until(() => held !== null),
    /** The window comes back from the back-forward cache and waits to be vetted again. */
    restore: () => {
      round.set({ kind: 'connecting' });
    },
    /** The site says hello again to the restored window, which sends a result it holds. */
    helloAgain: () => {
      if (held === null) {
        round.set(vetted);
      } else {
        end(held, { kind: 'answered' });
      }
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

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

/** Consents on the consent view and hands over the paired main session. */
async function consentAndDeliver(flow: SiteRound, h: Harness, result = PAIRED) {
  await h.until('consent');
  await flow.consent();
  h.windowFlow().deliver(result);
}

describe('site round', () => {
  it('As a user on a new site, I consent and the action runs for my main account, and the site gets its result and a token', async () => {
    // Given a site the main store keeps no grant for
    const h = await harness();

    // When the user consents and the window flow hands over the paired session
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the action ran once for the main account at the site's derivation index with no known key, and the site got
    // its result and a new token
    expect(h.runs.map(run => ({ main: run.input.main, index: run.input.index, knownKey: run.input.knownKey }))).toEqual(
      [{ main: MAIN, index: siteDerivationIndex(ORIGIN), knownKey: null }],
    );
    expect(h.posts).toEqual([{ type: 'dotli:s:result', result: RESULT, site_token: NEW_TOKEN }]);
    expect(await h.stored.list()).toEqual([
      { token: NEW_TOKEN, origin: ORIGIN, publicKey: toHex(SITE_KEY), owner: OWNER, firstUsedAt: NOW, lastUsedAt: NOW },
    ]);
    expect(h.screens).toEqual([
      { view: 'site-signing', origin: ORIGIN, route: 'sign' },
      { view: 'consent', origin: ORIGIN, statement: STATEMENT, group: null },
      { view: 'window' },
      { view: 'site-signing', origin: ORIGIN, route: 'sign' },
    ]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'granted', reason: 'new' }]);
  });

  it('As a site that got its result, I hear nothing more when the window flow closes the window', async () => {
    // Given a round that sent its result
    const h = await harness();
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // When the window flow closes the window, as it does once the round was answered
    h.windowFlow().close();

    // Then the site heard only its result, and the window closed again
    expect(h.posts.map(post => post.type)).toEqual(['dotli:s:result']);
    expect(h.closes()).toBe(2);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'granted', reason: 'new' }]);
  });

  it('As a site whose window came back from the back-forward cache before its result went out, I get the result on my next hello and only then does the window close', async () => {
    // Given a round whose window was restored before the action ran, so its result is held for the next vetting
    const h = await harness();
    await h.until('consent');
    await h.flow.consent();
    h.restore();
    h.windowFlow().deliver(PAIRED);
    await h.untilHeld();
    const closesWhileHeld = h.closes();

    // When the site says hello again
    h.helloAgain();
    await h.closed;

    // Then the window stayed open while the result was held, and closed once the site got it
    expect(closesWhileHeld).toBe(0);
    expect(h.posts.map(post => post.type)).toEqual(['dotli:s:result']);
    expect(h.closes()).toBe(1);
  });

  it('As a user with no session in the main store, I pair in the window and the site gets its result', async () => {
    // Given a main store with no session, so the window flow pairs, and a paired session handed over while the session
    // still authenticates, so the round waits on it
    const h = await harness({ auth: { tag: 'Disconnected' } });
    await h.until('consent');
    await h.flow.consent();
    h.auth.set({ tag: 'Authenticating' });
    h.windowFlow().deliver(PAIRED);
    await h.untilAuthWaited();
    const ranBefore = h.runs.length;

    // When the session connects
    h.auth.set(CONNECTED);
    await h.closed;

    // Then the action did not run before the session connected, ran once it had, and the site got its result
    expect(ranBefore).toBe(0);
    expect(h.runs.map(run => run.auth)).toEqual(['Connected']);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
  });

  it('As a site the user granted before, I skip consent, the action gets the kept key and I keep my token', async () => {
    // Given a grant for this site and this main account
    const h = await harness({ siteToken: TOKEN, grants: [grantOf()] });

    // When the window flow hands over the paired session
    await h.until('window');
    h.windowFlow().deliver(PAIRED);
    await h.closed;

    // Then no consent showed, the action got the kept key, the site got no new token and the grant's last use moved on
    expect(h.views()).not.toContain('consent');
    expect(h.runs.map(run => run.input.knownKey)).toEqual([KNOWN_KEY]);
    expect(resultOf(h.posts).site_token).toBeUndefined();
    expect(await h.stored.list()).toEqual([grantOf({ lastUsedAt: NOW })]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'granted', reason: 'known' }]);
  });

  it('As a site sending a token kept for another origin, I am asked for consent and get a new token', async () => {
    // Given a grant whose token the site sends but which another origin was given
    const h = await harness({ siteToken: TOKEN, grants: [grantOf({ origin: 'https://other.example' })] });

    // When the user consents and the window flow hands over the paired session
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the action got no known key and the site got a new token
    expect(h.runs.map(run => run.input.knownKey)).toEqual([null]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
  });

  it('As a user signed in with another main account, I forget the old grant, consent and the site gets a new token', async () => {
    // Given a grant for this site that another main account made
    const h = await harness({ siteToken: TOKEN, grants: [grantOf({ owner: '0xother' })] });
    await h.until('window');

    // When the window flow hands over the session, the user consents and the round goes on
    h.windowFlow().deliver(PAIRED);
    await h.until('consent');
    const forgotten = await h.stored.read(TOKEN);
    await h.flow.consent();
    await h.closed;

    // Then the old grant is gone, the action got no known key and the site got a new token
    expect(forgotten).toBeNull();
    expect(h.windowFlows).toHaveLength(1);
    expect(h.runs.map(run => run.input.knownKey)).toEqual([null]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
    expect((await h.stored.list()).map(grant => grant.token)).toEqual([NEW_TOKEN]);
  });

  it('As a user who declines a site, I refuse it with declined and the main store keeps no grant', async () => {
    // Given the consent view
    const h = await harness();
    await h.until('consent');

    // When the user declines
    h.flow.decline();
    await h.closed;

    // Then the site is refused as declined, the window closed with no other view, and nothing was kept
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'declined' }]);
    expect(h.views()).toEqual(['site-signing', 'consent']);
    expect(h.windowFlows).toHaveLength(0);
    expect(await h.stored.list()).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'refused', reason: 'declined' }]);
  });

  it('As a user signed in with only a local wallet, I refuse the site with unsupported_wallet', async () => {
    // Given a main store that holds only a local wallet
    const h = await harness();

    // When the window flow hands it over
    await consentAndDeliver(h.flow, h, { session: null, localWallet: { entropy: WALLET_ENTROPY, identity: null } });
    await h.closed;

    // Then the site is refused for the wallet and the action never ran
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'unsupported_wallet' }]);
    expect(h.runs).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'refused', reason: 'unsupported_wallet' }]);
  });

  it('As a user whose cached account is gone, I see the failure and retry from the main store', async () => {
    // Given a delivered session without its account
    const h = await harness();
    await consentAndDeliver(h.flow, h, { session: { blob: MAIN_BLOB, uiState: null }, localWallet: null });
    await h.until('site-failed');

    // When the user retries
    await h.flow.retry();
    await h.closed;

    // Then the retry read the account the main store caches and the site got its result
    expect(h.runs.map(run => run.input.main)).toEqual([MAIN]);
    expect(resultOf(h.posts).result).toEqual(RESULT);
    expect(h.metrics.counted(METRIC)).toEqual([
      { outcome: 'error', reason: 'cache' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });

  it('As a user who cancels on the consent view, I tell the site and close the window', async () => {
    // Given the consent view
    const h = await harness();
    await h.until('consent');

    // When the user cancels
    h.flow.cancel();
    await h.closed;

    // Then the site hears the round was cancelled
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user who cancels while the grant is kept, I leave no grant for a token the site never got', async () => {
    // Given a round whose new grant is being saved
    const gate = deferred<undefined>();
    const h = await harness({ saveGate: gate.promise });
    await consentAndDeliver(h.flow, h);
    await h.untilSaving();

    // When the user cancels and the save then commits
    h.flow.cancel();
    gate.resolve(undefined);
    await h.untilForgotten();

    // Then the site heard only the cancel, and the main store keeps no grant
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(await h.stored.list()).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user who cancels while the grant is kept, I see no failure when the save then fails, which is still reported', async () => {
    // Given a round whose new grant is being saved to a store that will fail it
    const gate = deferred<undefined>();
    const h = await harness({ saveGate: gate.promise, saveFails: true });
    await consentAndDeliver(h.flow, h);
    await h.untilSaving();

    // When the user cancels and the save then fails
    h.flow.cancel();
    gate.resolve(undefined);
    // A Retry queues behind the running step, so it resolves once the save's failure was handled.
    await h.flow.retry();

    // Then the round ended with the cancel alone and showed no failure, and the failed save was reported and counted
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.views()).not.toContain('site-failed');
    expect(h.errors).toHaveLength(1);
    expect(h.metrics.counted(METRIC)).toEqual([
      { outcome: 'cancelled', reason: 'page' },
      { outcome: 'error', reason: 'grant' },
    ]);
  });

  it('As a user who cancels while the action runs, I stop the action and the site hears only the cancel', async () => {
    // Given an action that runs until the test ends it
    const h = await harness({ held: true });
    await consentAndDeliver(h.flow, h);
    const run = await h.started();

    // When the user cancels and the action then ends with its result
    h.flow.cancel();
    run.finish();
    // A Retry queues behind the running step, so it resolves once the action's end was handled.
    await h.flow.retry();

    // Then the action's signal aborted, and the round ended with the cancel alone and kept no grant
    expect(run.input.signal.aborted).toBe(true);
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(await h.stored.list()).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user who cancels while an action that names its cancel runs, I refuse the site with that reason and not a cancel', async () => {
    // Given an action that runs until the test ends it and answers a Cancel with transaction_unknown
    const h = await harness({ held: true, cancelAs: 'transaction_unknown' });
    await consentAndDeliver(h.flow, h);
    const run = await h.started();

    // When the user cancels
    h.flow.cancel();
    await h.closed;

    // Then the action's signal aborted, the site was refused with the action's reason, once, and it counted as a refusal
    expect(run.input.signal.aborted).toBe(true);
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_unknown' }]);
    expect(h.closes()).toBe(1);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'refused', reason: 'transaction_unknown' }]);
  });

  it('As a user whose window flow failed to start, I retry and the window flow starts and the site gets its result', async () => {
    // Given a site granted before, whose window flow fails to start
    const h = await harness({ siteToken: TOKEN, grants: [grantOf()], windowFlowFails: true });
    await h.until('site-failed');

    // When the user retries and the started window flow hands over the paired session
    await h.flow.retry();
    h.windowFlow().deliver(PAIRED);
    await h.closed;

    // Then the retry started the window flow, and the site got its result
    expect(h.windowFlows).toHaveLength(1);
    expect(resultOf(h.posts).site_token).toBeUndefined();
    expect(h.metrics.counted(METRIC)).toEqual([
      { outcome: 'error', reason: 'action' },
      { outcome: 'granted', reason: 'known' },
    ]);
  });

  it('As a user whose site grants cannot be read, I am asked for consent as for a new site', async () => {
    // Given a grant for this site in a grants store whose read fails
    const h = await harness({ siteToken: TOKEN, grants: [grantOf()], readFails: true });

    // When the user consents and the window flow hands over the paired session
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the failed read was reported and counted, and the action got no known key and the site a new token
    expect(h.errors).toHaveLength(1);
    expect(h.metrics.counted(METRIC)).toEqual([
      { outcome: 'error', reason: 'grant_read' },
      { outcome: 'granted', reason: 'new' },
    ]);
    expect(h.runs.map(run => run.input.knownKey)).toEqual([null]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
  });

  it('As a site the action refuses, I am refused with its reason and the main store keeps no grant', async () => {
    // Given an action that refuses the site
    const h = await harness({ failures: [new SiteRoundRefusal('no_username')] });

    // When the round reaches the action
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the site is refused with the action's reason, nothing was kept and nothing was reported
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'no_username' }]);
    expect(await h.stored.list()).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'refused', reason: 'no_username' }]);
    expect(h.errors).toEqual([]);
  });

  it('As a site the action refuses for a failure, I am refused and the failure is reported once', async () => {
    // Given an action that refuses the site for a failure behind the refusal
    const failure = new Error('The chain refused the transaction');
    const captured = recordCaptures({ onFinished: onTestFinished });
    const h = await harness({ failures: [new SiteRoundRefusal('transaction_invalid', failure)] });

    // When the round reaches the action
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the site is refused, the refusal and its cause were reported once, and only the refusal was counted
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_invalid' }]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.args).toContainEqual(
      expect.objectContaining({ reason: 'transaction_invalid', cause: failure }),
    );
    expect(captured).toEqual([{ flow: 'wallet', step: 'site_round', tags: { reason: 'transaction_invalid' } }]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'refused', reason: 'transaction_invalid' }]);
  });

  it('As a site whose round the user left, I hear nothing of a refusal the action throws after', async () => {
    // Given an action that runs until the test ends it, and a user who cancelled meanwhile
    const h = await harness({ held: true });
    await consentAndDeliver(h.flow, h);
    const run = await h.started();
    h.flow.cancel();
    await h.closed;

    // When the action then refuses the site
    run.finish(new SiteRoundRefusal('bad_request'));
    // A Retry queues behind the running step, so it resolves once the refusal was handled.
    await h.flow.retry();

    // Then the site heard only the cancel, counted once, and the window was not closed again
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
    expect(h.closes()).toBe(1);
  });

  it('As a user who rejects the request on the phone, I cancel the round and keep no grant', async () => {
    // Given an action the user rejects on the phone
    const h = await harness({ failures: [new SiteRoundRejected()] });

    // When the round reaches the action
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the site hears the round was cancelled and nothing was kept
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(await h.stored.list()).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'cancelled', reason: 'phone' }]);
  });

  it('As a user whose action failed, I see the failure with Try again, retry and the site gets its result', async () => {
    // Given an action that fails once at a step that may be tried again
    const h = await harness({ failures: [new SiteRoundFailure('chain', true, 'The chain is out of reach')] });
    await consentAndDeliver(h.flow, h);
    await h.until('site-failed');
    const failed = { screen: h.flow.screen.get(), posts: [...h.posts], errors: h.errors.length };

    // When the user retries
    await h.flow.retry();
    await h.closed;

    // Then the failure showed for the route with Try again and nothing sent, and the retry ran the action again
    expect(failed).toEqual({
      screen: { view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true },
      posts: [],
      errors: 1,
    });
    expect(h.runs).toHaveLength(2);
    expect(resultOf(h.posts).result).toEqual(RESULT);
    expect(h.metrics.counted(METRIC)).toEqual([
      { outcome: 'error', reason: 'chain' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });

  it('As a user whose action failed past trying again, I see the failure without Try again and a Retry does nothing', async () => {
    // Given an action that fails at a step that may not be tried again
    const h = await harness({ failures: [new SiteRoundFailure('submit', false, 'The watch was lost')] });
    await consentAndDeliver(h.flow, h);
    await h.until('site-failed');

    // When a Retry is asked anyway
    await h.flow.retry();

    // Then the failure shows without Try again, the action ran only once and the site heard nothing
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: false });
    expect(h.runs).toHaveLength(1);
    expect(h.posts).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'error', reason: 'submit' }]);
  });

  it('As a user whose action failed for a reason it does not name, I see the failure with Try again counted for the action', async () => {
    // Given an action that throws an error of its own
    const h = await harness({ failures: [new Error('Something broke')] });

    // When the round reaches the action
    await consentAndDeliver(h.flow, h);
    await h.until('site-failed');

    // Then the failure shows with Try again, is reported and counted for the action, and the site heard nothing
    expect(h.flow.screen.get()).toEqual({ view: 'site-failed', origin: ORIGIN, route: 'sign', retry: true });
    expect(h.errors).toHaveLength(1);
    expect(h.posts).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'error', reason: 'action' }]);
  });

  it('As a user, I press confirm before the action asks for one and the press goes nowhere', async () => {
    // Given an action that runs until the test ends it
    const h = await harness({ held: true });
    await consentAndDeliver(h.flow, h);
    const run = await h.started();
    const settled: string[] = [];

    // When the user presses confirm before the action asks, then the action asks and the user presses again
    h.flow.confirm();
    const asked = run.input.confirmed();
    void asked.then(() => settled.push('asked'));
    const witness = Promise.resolve().then(() => settled.push('witness'));
    await witness;
    h.flow.confirm();
    await asked;

    // Then the ask settled only with the press made while it was pending
    expect(settled).toEqual(['witness', 'asked']);
  });

  it('As a user, I press confirm after the action showed another view and only its next ask settles', async () => {
    // Given an action that asks for a confirm and then shows another view
    const h = await harness({ held: true });
    await consentAndDeliver(h.flow, h);
    const run = await h.started();
    const settled: string[] = [];
    const first = run.input.confirmed();
    void first.then(
      () => settled.push('first'),
      () => settled.push('first rejected'),
    );
    run.input.show({ view: 'site-signing', origin: ORIGIN, route: 'sign' });

    // When the user presses confirm, then the action asks again and the user presses once more
    h.flow.confirm();
    const second = run.input.confirmed();
    void second.then(() => settled.push('second'));
    h.flow.confirm();
    await second;

    // Then the first ask rejected as the other view showed, and only the second settled with a press
    expect(settled).toEqual(['first rejected', 'second']);
  });

  it('As a user who cancels while the action waits for my confirm, I end its wait', async () => {
    // Given an action that waits for the user's confirm
    const h = await harness({ held: true });
    await consentAndDeliver(h.flow, h);
    const run = await h.started();
    const asked = run.input.confirmed();

    // When the user cancels
    h.flow.cancel();

    // Then the wait rejects and the site heard only the cancel
    await expect(asked).rejects.toThrow();
    expect(h.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
  });
});

const SHOP = 'https://shop.my-site.com';
const GROUP_INDEX = groupDerivationIndex('my-site.com', GROUP_TOKEN);

/** A grant of `registrable`'s group under {@link GROUP_TOKEN}, made by `origin`. */
function groupGrantOf(registrable: string, fields: Partial<SiteGrant> = {}): SiteGrant {
  const origin = fields.origin ?? ORIGIN;
  return grantOf({ origin, group: { registrable, token: GROUP_TOKEN, origins: [origin] }, ...fields });
}

describe('site round of a group', () => {
  it('As a user on a new site of a group, I consent naming its registrable domain and the action runs for the group', async () => {
    // Given a site that asks under a group token, with no grant kept
    const h = await harness({ groupToken: GROUP_TOKEN });

    // When the user consents and the window flow hands over the paired session
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the consent named the group's registrable domain, the action ran at the group's index, and the site got a
    // new token for a grant of the group
    expect(h.screens).toContainEqual({ view: 'consent', origin: ORIGIN, statement: STATEMENT, group: 'my-site.com' });
    expect(h.runs.map(run => ({ index: run.input.index, knownKey: run.input.knownKey }))).toEqual([
      { index: GROUP_INDEX, knownKey: null },
    ]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
    expect(await h.stored.list()).toEqual([
      {
        token: NEW_TOKEN,
        origin: ORIGIN,
        publicKey: toHex(SITE_KEY),
        owner: OWNER,
        firstUsedAt: NOW,
        lastUsedAt: NOW,
        group: { registrable: 'my-site.com', token: GROUP_TOKEN, origins: [ORIGIN] },
      },
    ]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'granted', reason: 'group' }]);
  });

  it("As another origin of a group, I send the group's token and skip consent, and my origin joins the grant", async () => {
    // Given a grant another origin of the group made, whose token this origin sends with the group token
    const h = await harness({
      origin: SHOP,
      siteToken: TOKEN,
      groupToken: GROUP_TOKEN,
      grants: [groupGrantOf('my-site.com')],
    });

    // When the window flow hands over the paired session
    await h.until('window');
    h.windowFlow().deliver(PAIRED);
    await h.closed;

    // Then no consent showed, the action got the group's key at the group's index, the site kept its token and the
    // grant lists both origins
    expect(h.views()).not.toContain('consent');
    expect(h.runs.map(run => ({ index: run.input.index, knownKey: run.input.knownKey }))).toEqual([
      { index: GROUP_INDEX, knownKey: KNOWN_KEY },
    ]);
    expect(resultOf(h.posts).site_token).toBeUndefined();
    expect(await h.stored.list()).toEqual([
      groupGrantOf('my-site.com', {
        lastUsedAt: NOW,
        group: { registrable: 'my-site.com', token: GROUP_TOKEN, origins: [ORIGIN, SHOP] },
      }),
    ]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'granted', reason: 'group' }]);
  });

  it.each([
    ['a grant of another registrable domain', ORIGIN, 'my-site.com', 'https://other.com', 'other.com'],
    [
      'a grant of a github.io sibling',
      'https://bob.github.io',
      'bob.github.io',
      'https://alice.github.io',
      'alice.github.io',
    ],
    ['a grant of a 0.bg sibling', 'https://y.0.bg', 'y.0.bg', 'https://x.0.bg', 'x.0.bg'],
  ])(
    'As a site of a group sending the token of %s, I am asked for consent and get a grant of my own',
    async (_name, origin, registrable, grantOrigin, grantRegistrable) => {
      // Given a group grant of the same group token under another registrable domain, whose token the site sends
      const h = await harness({
        origin,
        siteToken: TOKEN,
        groupToken: GROUP_TOKEN,
        grants: [groupGrantOf(grantRegistrable, { origin: grantOrigin })],
      });

      // When the user consents and the window flow hands over the paired session
      await consentAndDeliver(h.flow, h);
      await h.closed;

      // Then the consent named the site's own registrable domain, the action got no known key, and the site got a new
      // token for a grant apart from the other
      expect(h.screens).toContainEqual({ view: 'consent', origin, statement: STATEMENT, group: registrable });
      expect(h.runs.map(run => run.input.knownKey)).toEqual([null]);
      expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
      expect((await h.stored.list()).map(grant => grant.group?.registrable).sort()).toEqual(
        [grantRegistrable, registrable].sort(),
      );
    },
  );

  it.each([
    ['a group grant without a group token', { siteToken: TOKEN, grants: [groupGrantOf('my-site.com')] }],
    ['a grant of no group with a group token', { siteToken: TOKEN, groupToken: GROUP_TOKEN, grants: [grantOf()] }],
  ])('As a site sending the token of %s, I am asked for consent', async (_name, options) => {
    // Given a grant whose token the site sends, of a group the request does not name the same way
    const h = await harness(options);

    // When the user consents and the window flow hands over the paired session
    await consentAndDeliver(h.flow, h);
    await h.closed;

    // Then the action got no known key and the site got a new token
    expect(h.runs.map(run => run.input.knownKey)).toEqual([null]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
  });

  it.each([
    ['on a public suffix', 'https://github.io', SELF],
    ["on the window's own registrable domain", 'https://my-app.dot.li', SELF],
    ['beside a window on a subdomain', 'https://my-app.dot.li', 'https://signin.dot.li'],
  ])('As a site of a group %s, I am refused with bad_request before any consent', async (_name, origin, self) => {
    // Given a site that asks under a group token from an origin no group may have
    const h = await harness({ origin, self, groupToken: GROUP_TOKEN });

    // When the round judges the request
    await h.closed;

    // Then the site was refused as a bad request with no consent shown and nothing kept or reported
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(h.views()).not.toContain('consent');
    expect(h.runs).toEqual([]);
    expect(await h.stored.list()).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.metrics.counted(METRIC)).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
  });

  it('As a site of a group whose window cannot load the suffix list, I am refused with bad_request and the failure is reported', async () => {
    // Given a window whose Public Suffix List does not load
    const groups: SiteGroups = { registrable: () => Promise.reject(new Error('The list did not load')) };
    const h = await harness({ groupToken: GROUP_TOKEN, groups });

    // When the round judges the request
    await h.closed;

    // Then the site was refused as a bad request, and the load was reported and counted
    expect(h.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(h.views()).not.toContain('consent');
    expect(h.errors).toHaveLength(1);
    expect(h.metrics.counted(METRIC)).toEqual([
      { outcome: 'error', reason: 'group_list' },
      { outcome: 'refused', reason: 'bad_request' },
    ]);
  });

  it('As a user who cancels one round of a group during its save while another round of the group saved, I keep the one grant', async () => {
    // Given round A of the group, whose grant is being saved, and round B of the group on another origin, which saved
    // its grant meanwhile and sent its token
    const OTHER_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(3));
    const store = createSiteGrantStore(memorySiteGrantsIdb());
    const gate = deferred<undefined>();
    const a = await harness({ store, groupToken: GROUP_TOKEN, saveGate: gate.promise });
    await consentAndDeliver(a.flow, a);
    await a.untilSaving();
    const b = await harness({ store, origin: SHOP, groupToken: GROUP_TOKEN, newToken: OTHER_TOKEN });
    await consentAndDeliver(b.flow, b);
    await b.closed;

    // When the user cancels round A and its save then commits
    a.flow.cancel();
    gate.resolve(undefined);
    // A Retry queues behind the running step, so it resolves once the save's end was handled.
    await a.flow.retry();

    // Then round A's site heard only the cancel, and the group keeps the one grant round B's site holds, with both
    // origins
    expect(a.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(resultOf(b.posts).site_token).toBe(OTHER_TOKEN);
    expect(await store.list()).toEqual([
      {
        token: OTHER_TOKEN,
        origin: SHOP,
        publicKey: toHex(SITE_KEY),
        owner: OWNER,
        firstUsedAt: NOW,
        lastUsedAt: NOW,
        group: { registrable: 'my-site.com', token: GROUP_TOKEN, origins: [SHOP, ORIGIN] },
      },
    ]);
  });

  it("As a user signed in with another main account, I forget that account's group grant and am asked for consent", async () => {
    // Given a group grant another main account made, whose token the site sends with the group token
    const h = await harness({
      siteToken: TOKEN,
      groupToken: GROUP_TOKEN,
      grants: [groupGrantOf('my-site.com', { owner: '0xother' })],
    });
    await h.until('window');

    // When the window flow hands over the session, the user consents and the round goes on
    h.windowFlow().deliver(PAIRED);
    await h.until('consent');
    const forgotten = await h.stored.read(TOKEN);
    await h.flow.consent();
    await h.closed;

    // Then the old grant is gone, the consent named the group, and the site got a new token for this account's grant
    expect(forgotten).toBeNull();
    expect(h.screens).toContainEqual({ view: 'consent', origin: ORIGIN, statement: STATEMENT, group: 'my-site.com' });
    expect(h.runs.map(run => run.input.knownKey)).toEqual([null]);
    expect(resultOf(h.posts).site_token).toBe(NEW_TOKEN);
    expect((await h.stored.list()).map(grant => ({ token: grant.token, owner: grant.owner }))).toEqual([
      { token: NEW_TOKEN, owner: OWNER },
    ]);
  });
});

describe('unsent grant', () => {
  it('As a site whose answer never reached it, I hold no token, so the grant the round kept for me is forgotten', () => {
    // Given a kept grant of no group
    const grant = grantOf();

    // When the window asks whether an unsent answer forgets it
    const forgets = forgetsUnsentGrant(grant);

    // Then it does
    expect(forgets).toBe(true);
  });

  it("As another origin of a group, I may hold the group's token, so its grant stays when one origin's answer never arrived", () => {
    // Given a kept grant of a group
    const grant = groupGrantOf('my-site.com');

    // When the window asks whether an unsent answer forgets it
    const forgets = forgetsUnsentGrant(grant);

    // Then it does not
    expect(forgets).toBe(false);
  });
});
