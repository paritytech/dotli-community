// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { base64urlnopad } from '@scure/base';
import { defineCount } from '@dotli/metrics';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrant, type SiteGrantStore } from '@dotli/storage';
import { createMemorySiteGrantsIdb } from '@dotli/storage/testing';
import { CoreRedialError } from '../coreRedialError.js';
import { createChanges } from '../../testing/changes.js';
import { MainAccountError, type MainAccount } from './createMainAccountSource.js';
import { createSiteRound, type SiteAction, type SiteScreen } from './createSiteRound.js';
import { createRecordingResponder } from '../sessionHandoff/createResponder.fake.js';
import { consentAndStore } from '../../testing/consentAndStore.js';
import { createGrant } from '../../testing/createGrant.js';
import { getResult } from '../../testing/getResult.js';
import {
  MAIN_ACCOUNT,
  MAIN_OWNER,
  NEW_SITE_TOKEN,
  ROUND_NOW,
  SITE_ORIGIN,
  SITE_TOKEN,
} from '../../testing/siteRoundConstants.js';
import { waitForView } from '../../testing/waitForView.js';
import { SITE_GROUPS } from './createSiteGroups.fake.js';
import { SiteRoundFailure, SiteRoundRefusal, SiteRoundRejected } from './siteRoundErrors.js';
import type { SiteGroups } from './createSiteGroups.js';

/** What the fake action answers the site. */
type FakeResult = {
  done: string;
};

type RunInput = Parameters<SiteAction<FakeResult, 'granted'>['run']>[0];

/** One run of the action, which the test may finish itself. */
type ActionRun = {
  input: RunInput;
  /** Ends the run with its result, or with `error`. */
  finish: (options?: FinishParams) => void;
};

type FinishParams = {
  /** The failure the run ends with, in place of its result. */
  error?: Error | undefined;
};

type StartRoundParams = {
  /** The site's origin, {@link SITE_ORIGIN} by default. */
  origin?: string;
  /** The window's own origin, {@link SELF} by default. */
  self?: string;
  siteToken?: string | null;
  groupToken?: string | null;
  /** The registrable domains the round judges a group by, {@link SITE_GROUPS} by default. */
  groups?: SiteGroups;
  /** A grants store another round shares, in place of a new one. */
  store?: SiteGrantStore;
  /** The token a new grant gets, {@link NEW_SITE_TOKEN} by default. */
  newToken?: string;
  /** Grants the main store keeps before the round. */
  grants?: SiteGrant[];
  /** Reads the main account the window's core reports, {@link MAIN_ACCOUNT} at once by default. */
  mainAccount?: (signal: AbortSignal) => Promise<MainAccount>;
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
  /** The action's `prepare`, which the action lacks by default. */
  prepare?: (signal: AbortSignal) => void;
};

const SHOP = 'https://shop.my-site.com';
const SELF = 'https://dot.li';
const METRIC = defineCount<'granted' | 'refused' | 'cancelled' | 'error'>('test.site_round');

const GROUP_TOKEN = 'my group';

const RESULT: FakeResult = { done: 'the action ran' };

/** A grant of `registrable`'s group under {@link GROUP_TOKEN}, made by `origin`. */
function createGroupGrant(registrable: string, fields: Partial<SiteGrant> = {}): SiteGrant {
  const origin = fields.origin ?? SITE_ORIGIN;
  return createGrant({ origin, group: { registrable, token: GROUP_TOKEN, origins: [origin] }, ...fields });
}

/**
 * A site's round over fakes: a responder that records what it posts, ends its round on its first terminal call and
 * holds a result sent while it waits to be vetted again, an in-memory grants store, an action the test scripts, and a
 * window flow the test says stored a sign-in through.
 */
async function startRound(options: StartRoundParams = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  // Notified when an action runs, a save starts, a forget ends, the round reads the main account or a result is held,
  // which a test waits on.
  const changes = createChanges();
  const origin = options.origin ?? SITE_ORIGIN;
  const recording = createRecordingResponder({ origin, onHeld: changes.notify });
  const { responder, posts } = recording;
  const stored = options.store ?? createSiteGrantStore({ idb: createMemorySiteGrantsIdb() });
  for (const grant of options.grants ?? []) {
    await stored.save(grant);
  }
  let saving = 0;
  let forgotten = 0;
  // The signal of each read of the main account.
  const mainReads: AbortSignal[] = [];
  /** Counts a save, then holds it at the gate and fails it when the test says so. */
  async function gateSave(): Promise<void> {
    saving += 1;
    changes.notify();
    await options.saveGate;
    if (options.saveFails === true) {
      throw new Error('The grants database is full');
    }
  }
  const grants: SiteGrantStore = {
    ...stored,
    async save(grant) {
      await gateSave();
      await stored.save(grant);
    },
    async saveGroup(grant) {
      await gateSave();
      return stored.saveGroup(grant);
    },
    async forget(token) {
      await stored.forget(token);
      forgotten += 1;
      changes.notify();
    },
    read(token) {
      return options.readFails === true
        ? Promise.reject(new Error('The grants database is closed'))
        : stored.read(token);
    },
  };
  const readMain = options.mainAccount ?? (() => Promise.resolve(MAIN_ACCOUNT));
  const failures = [...(options.failures ?? [])];
  const runs: ActionRun[] = [];
  const action: SiteAction<FakeResult, 'granted'> = {
    route: 'sign',
    metric: METRIC,
    outcome: () => 'granted',
    run(input) {
      const failure = failures.shift();
      const done = createDeferred<FakeResult>();
      function finish({ error }: FinishParams = {}): void {
        if (error === undefined) {
          done.resolve(RESULT);
        } else {
          done.reject(error);
        }
      }
      runs.push({ input, finish });
      changes.notify();
      if (failure !== undefined) {
        finish({ error: failure });
      } else if (options.held !== true) {
        finish();
      }
      return done.promise;
    },
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
  };
  let windowFlowFails = options.windowFlowFails === true;
  const windowFlows: { stored: () => void; close: () => void }[] = [];
  const closed = createDeferred<undefined>();
  let closes = 0;
  const flow = createSiteRound({
    request: {
      round: 'r1',
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
    },
    origin,
    self: options.self ?? SELF,
    responder,
    grants,
    groups: options.groups ?? SITE_GROUPS,
    mainAccount(signal) {
      mainReads.push(signal);
      changes.notify();
      return readMain(signal);
    },
    startWindowFlow(storedSignIn, close) {
      if (windowFlowFails) {
        windowFlowFails = false;
        throw new Error('The window flow could not start');
      }
      windowFlows.push({ stored: storedSignIn, close });
    },
    now: () => ROUND_NOW,
    randomToken: () => options.newToken ?? NEW_SITE_TOKEN,
    close() {
      closes += 1;
      closed.resolve(undefined);
    },
    action,
  });
  const screens: SiteScreen[] = [];
  onTestFinished(
    flow.screen.subscribe(screen => {
      screens.push(screen);
    }),
  );
  return {
    flow,
    posts,
    stored,
    runs,
    mainReads,
    screens,
    readViews: () => screens.map(shown => shown.view),
    metrics,
    errors,
    closed: closed.promise,
    countCloses: () => closes,
    /** The window flow the round started, which the test says stored a sign-in through. */
    getWindowFlow: () => must(windowFlows[0], 'a started window flow'),
    /** The window flow the round started says a sign-in is stored. */
    storeSignIn(): void {
      must(windowFlows[0], 'a started window flow').stored();
    },
    windowFlows,
    /** Resolves once the screen shows `view`. */
    waitForView: (view: SiteScreen['view']) => waitForView(flow.screen, view),
    /** Resolves with the action's first run once it ran. */
    async waitForRun(): Promise<ActionRun> {
      await changes.until(() => runs.length > 0);
      return must(runs[0], 'a run of the action');
    },
    /** Resolves once a grant save started. */
    waitForSaving: () => changes.until(() => saving > 0),
    /** Resolves once a grant was forgotten. */
    waitForForgotten: () => changes.until(() => forgotten > 0),
    /** Resolves once a result waits for the window to be vetted again. */
    waitForHeld: () => changes.until(recording.isHolding),
    /** The window comes back from the back-forward cache and waits to be vetted again. */
    restore: recording.restore,
    /** The site says hello again to the restored window, which sends a result it holds. */
    sayHelloAgain: recording.sayHelloAgain,
  };
}

describe('site round', () => {
  it('As a user on a new site, I consent and the action runs for my main account, and the site gets its result and a token', async () => {
    // Given a site the main store keeps no grant for
    const round = await startRound();

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(round);
    await round.closed;

    // Then the action ran once for the main account, and the site got its result and a new token for a grant that keeps
    // no key
    expect(round.runs.map(run => run.input.main)).toEqual([MAIN_ACCOUNT]);
    expect(round.posts).toEqual([{ type: 'dotli:s:result', result: RESULT, site_token: NEW_SITE_TOKEN }]);
    expect(await round.stored.list()).toEqual([
      { token: NEW_SITE_TOKEN, origin: SITE_ORIGIN, owner: MAIN_OWNER, firstUsedAt: ROUND_NOW, lastUsedAt: ROUND_NOW },
    ]);
    expect(round.screens).toEqual([
      { view: 'site-signing', origin: SITE_ORIGIN, route: 'sign' },
      { view: 'consent', origin: SITE_ORIGIN, group: null },
      { view: 'window' },
      { view: 'site-signing', origin: SITE_ORIGIN, route: 'sign' },
    ]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'granted', reason: 'new' }]);
  });

  it('As a site that got its result, I see the window flow close the window and hear nothing more', async () => {
    // Given a round that sent its result
    const round = await startRound();
    await consentAndStore(round);
    await round.closed;

    // When the window flow closes the window, as it does once the round was answered
    round.getWindowFlow().close();

    // Then the site heard only its result, and the window closed again
    expect(round.posts.map(post => post.type)).toEqual(['dotli:s:result']);
    expect(round.countCloses()).toBe(2);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'granted', reason: 'new' }]);
  });

  it('As a site whose window came back from the back-forward cache before its result went out, I get the result on my next hello and only then does the window close', async () => {
    // Given a round whose window was restored before the action ran, so its result is held for the next vetting
    const round = await startRound();
    await round.waitForView('consent');
    await round.flow.consent();
    round.restore();
    round.storeSignIn();
    await round.waitForHeld();
    const closesWhileHeld = round.countCloses();

    // When the site says hello again
    round.sayHelloAgain();
    await round.closed;

    // Then the window stayed open while the result was held, and closed once the site got it
    expect(closesWhileHeld).toBe(0);
    expect(round.posts.map(post => post.type)).toEqual(['dotli:s:result']);
    expect(round.countCloses()).toBe(1);
  });

  it("As a user, I start a site's round and it reads the main account only once the core reports it", async () => {
    // Given a core whose first report the main account cannot be read from
    let reads = 0;
    const round = await startRound({
      mainAccount() {
        reads += 1;
        return reads === 1
          ? Promise.reject(new MainAccountError('unavailable', 'The session carries no readable key'))
          : Promise.resolve(MAIN_ACCOUNT);
      },
    });
    await consentAndStore(round);
    await round.waitForView('site-failed');
    const failed = round.flow.screen.get();

    // When the user presses Try again
    await round.flow.retry();
    await round.closed;

    // Then the failure offered Try again, which read the main account again with the round's signal, and the action ran
    expect(failed).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: true });
    expect(round.mainReads).toHaveLength(2);
    expect(round.mainReads.every(signal => signal.aborted)).toBe(true);
    expect(round.windowFlows).toHaveLength(1);
    expect(round.runs.map(run => run.input.main)).toEqual([MAIN_ACCOUNT]);
    expect(round.metrics.counted('test.site_round')).toEqual([
      { outcome: 'error', reason: 'main_account' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });

  it('As a user whose stored session is gone, I press Try again and the window starts the sign-in flow again', async () => {
    // Given a core that reports the stored session gone, then the session the new sign-in stored
    let reads = 0;
    const round = await startRound({
      mainAccount() {
        reads += 1;
        return reads === 1
          ? Promise.reject(new MainAccountError('signed_out', 'The main session ended'))
          : Promise.resolve(MAIN_ACCOUNT);
      },
    });
    await consentAndStore(round);
    await round.waitForView('site-failed');

    // When the user presses Try again
    await round.flow.retry();
    const readsOnRetry = round.mainReads.length;
    must(round.windowFlows[1], 'a second window flow').stored();
    await round.closed;

    // Then Try again started the window flow again instead of reading the main account, and its sign-in went on
    expect(readsOnRetry).toBe(1);
    expect(round.windowFlows).toHaveLength(2);
    expect(round.mainReads).toHaveLength(2);
    expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
  });

  it('As an operator, I see a round whose core could not boot again counted, and the round does not capture the core redial', async () => {
    // Given a core whose redial failed, which the page core already reported
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const redial = new CoreRedialError(new Error('The worker crashed'));
    const round = await startRound({
      mainAccount: () =>
        Promise.reject(new MainAccountError('unavailable', 'The core could not boot', { cause: redial })),
    });

    // When the round reads the main account
    await consentAndStore(round);
    await round.waitForView('site-failed');

    // Then the failure is counted and not captured again
    expect(captured).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'error', reason: 'main_account' }]);
  });

  it('As an operator, I see a round whose stored session is gone counted and not captured', async () => {
    // Given a core that reports the stored session gone, which only a new sign-in brings back
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const round = await startRound({
      mainAccount: () => Promise.reject(new MainAccountError('signed_out', 'The main session ended')),
    });

    // When the round reads the main account
    await consentAndStore(round);
    await round.waitForView('site-failed');

    // Then the failure is counted as the main account's and nothing is captured
    expect(captured).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'error', reason: 'main_account' }]);
  });

  it('As a site the user granted before, I skip consent and keep my token', async () => {
    // Given a grant for this site and this main account
    const round = await startRound({ siteToken: SITE_TOKEN, grants: [createGrant()] });

    // When the window flow says a sign-in is stored
    await round.waitForView('window');
    round.storeSignIn();
    await round.closed;

    // Then no consent showed, the action ran for the main account, the site got no new token and the grant's last use
    // moved on
    expect(round.readViews()).not.toContain('consent');
    expect(round.runs.map(run => run.input.main)).toEqual([MAIN_ACCOUNT]);
    expect(getResult(round.posts).site_token).toBeUndefined();
    expect(await round.stored.list()).toEqual([createGrant({ lastUsedAt: ROUND_NOW })]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'granted', reason: 'known' }]);
  });

  it('As a site sending a token kept for another origin, I am asked for consent and get a new token', async () => {
    // Given a grant whose token the site sends but which another origin was given
    const round = await startRound({
      siteToken: SITE_TOKEN,
      grants: [createGrant({ origin: 'https://other.example' })],
    });

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(round);
    await round.closed;

    // Then the site got a new token
    expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
  });

  it('As a user signed in with another main account, I forget the old grant, consent and the site gets a new token', async () => {
    // Given a grant for this site that another main account made
    const round = await startRound({ siteToken: SITE_TOKEN, grants: [createGrant({ owner: '0xother' })] });
    await round.waitForView('window');

    // When the window flow says a sign-in is stored, the user consents and the round goes on
    round.storeSignIn();
    await round.waitForView('consent');
    const forgotten = await round.stored.read(SITE_TOKEN);
    await round.flow.consent();
    await round.closed;

    // Then the old grant is gone and the site got a new token
    expect(forgotten).toBeNull();
    expect(round.windowFlows).toHaveLength(1);
    expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
    expect((await round.stored.list()).map(grant => grant.token)).toEqual([NEW_SITE_TOKEN]);
  });

  it('As a user who declines a site, I refuse it with declined and the main store keeps no grant', async () => {
    // Given the consent view
    const round = await startRound();
    await round.waitForView('consent');

    // When the user declines
    round.flow.decline();
    await round.closed;

    // Then the site is refused as declined, the window closed with no other view, and nothing was kept
    expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'declined' }]);
    expect(round.readViews()).toEqual(['site-signing', 'consent']);
    expect(round.windowFlows).toHaveLength(0);
    expect(await round.stored.list()).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'refused', reason: 'declined' }]);
  });

  it('As a site, I start a round and the window prepares its action at once with a signal that aborts once the round ends', async () => {
    // Given an action that records its prepare and keeps its signal, a round started up to its consent view, and
    // whether the signal was aborted there
    const events: string[] = [];
    const signals: AbortSignal[] = [];
    const round = await startRound({
      prepare(signal) {
        events.push('prepare');
        signals.push(signal);
      },
    });
    await round.waitForView('consent');
    events.push('consent');
    const abortedAtConsent = signals.map(signal => signal.aborted);

    // When the user declines
    round.flow.decline();
    await round.closed;

    // Then the action prepared once before the consent showed, with a signal that stayed live until the round ended
    expect(events).toEqual(['prepare', 'consent']);
    expect(abortedAtConsent).toEqual([false]);
    expect(signals.map(signal => signal.aborted)).toEqual([true]);
  });

  it('As a user, I cancel while the grant is kept and no grant is left for a token the site never got', async () => {
    // Given a round whose new grant is being saved
    const gate = createDeferred<undefined>();
    const round = await startRound({ saveGate: gate.promise });
    await consentAndStore(round);
    await round.waitForSaving();

    // When the user cancels and the save then commits
    round.flow.cancel();
    gate.resolve(undefined);
    await round.waitForForgotten();

    // Then the site heard only the cancel, and the main store keeps no grant
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(await round.stored.list()).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user, I cancel while the grant is kept and see no failure when the save then fails, which is still reported', async () => {
    // Given a round whose new grant is being saved to a store that will fail it
    const gate = createDeferred<undefined>();
    const round = await startRound({ saveGate: gate.promise, saveFails: true });
    await consentAndStore(round);
    await round.waitForSaving();

    // When the user cancels and the save then fails
    round.flow.cancel();
    gate.resolve(undefined);
    // A Retry queues behind the running step, so it resolves once the save's failure was handled.
    await round.flow.retry();

    // Then the round ended with the cancel alone and showed no failure, and the failed save was reported and counted
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(round.readViews()).not.toContain('site-failed');
    expect(round.errors).toHaveLength(1);
    expect(round.metrics.counted('test.site_round')).toEqual([
      { outcome: 'cancelled', reason: 'page' },
      { outcome: 'error', reason: 'grant' },
    ]);
  });

  it('As a user who cancels while the action runs, I stop the action and the site hears only the cancel', async () => {
    // Given an action that runs until the test ends it
    const round = await startRound({ held: true });
    await consentAndStore(round);
    const run = await round.waitForRun();

    // When the user cancels and the action then ends with its result
    round.flow.cancel();
    run.finish();
    // A Retry queues behind the running step, so it resolves once the action's end was handled.
    await round.flow.retry();

    // Then the action's signal aborted, and the round ended with the cancel alone and kept no grant
    expect(run.input.signal.aborted).toBe(true);
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(await round.stored.list()).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user whose window flow failed to start, I retry and the window flow starts and the site gets its result', async () => {
    // Given a site granted before, whose window flow fails to start
    const round = await startRound({ siteToken: SITE_TOKEN, grants: [createGrant()], windowFlowFails: true });
    await round.waitForView('site-failed');

    // When the user retries and the started window flow says a sign-in is stored
    await round.flow.retry();
    round.storeSignIn();
    await round.closed;

    // Then the retry started the window flow, and the site got its result
    expect(round.windowFlows).toHaveLength(1);
    expect(getResult(round.posts).site_token).toBeUndefined();
    expect(round.metrics.counted('test.site_round')).toEqual([
      { outcome: 'error', reason: 'action' },
      { outcome: 'granted', reason: 'known' },
    ]);
  });

  it('As a user whose site grants cannot be read, I sign in to a site I used before and am asked for consent as for a new site', async () => {
    // Given a grant for this site in a grants store whose read fails
    const round = await startRound({ siteToken: SITE_TOKEN, grants: [createGrant()], readFails: true });

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(round);
    await round.closed;

    // Then the failed read was reported and counted, and the site got a new token
    expect(round.errors).toHaveLength(1);
    expect(round.metrics.counted('test.site_round')).toEqual([
      { outcome: 'error', reason: 'grant_read' },
      { outcome: 'granted', reason: 'new' },
    ]);
    expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
  });

  it('As a site the action refuses, I am refused with its reason and the main store keeps no grant', async () => {
    // Given an action that refuses the site
    const round = await startRound({ failures: [new SiteRoundRefusal('bad_request')] });

    // When the round reaches the action
    await consentAndStore(round);
    await round.closed;

    // Then the site is refused with the action's reason, nothing was kept and nothing was reported
    expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(await round.stored.list()).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
    expect(round.errors).toEqual([]);
  });

  it('As a site the action refuses for a failure, I am refused and the failure is reported once', async () => {
    // Given an action that refuses the site for a failure behind the refusal
    const failure = new Error('The chain refused the transaction');
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const round = await startRound({ failures: [new SiteRoundRefusal('transaction_invalid', { cause: failure })] });

    // When the round reaches the action
    await consentAndStore(round);
    await round.closed;

    // Then the site is refused, the refusal and its cause were reported once, and only the refusal was counted
    expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'transaction_invalid' }]);
    expect(round.errors).toHaveLength(1);
    expect(round.errors[0]?.args).toContainEqual(
      expect.objectContaining({ reason: 'transaction_invalid', cause: failure }),
    );
    expect(captured).toMatchObject([{ step: 'site_round', tags: { reason: 'transaction_invalid' } }]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'refused', reason: 'transaction_invalid' }]);
  });

  it('As a site whose round the user left, I wait and hear nothing of a refusal the action throws after', async () => {
    // Given an action that runs until the test ends it, and a user who cancelled meanwhile
    const round = await startRound({ held: true });
    await consentAndStore(round);
    const run = await round.waitForRun();
    round.flow.cancel();
    await round.closed;

    // When the action then refuses the site
    run.finish({ error: new SiteRoundRefusal('bad_request') });
    // A Retry queues behind the running step, so it resolves once the refusal was handled.
    await round.flow.retry();

    // Then the site heard only the cancel, counted once, and the window was not closed again
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
    expect(round.countCloses()).toBe(1);
  });

  it('As a user who rejects the request on the phone, I cancel the round and keep no grant', async () => {
    // Given an action the user rejects on the phone
    const round = await startRound({ failures: [new SiteRoundRejected()] });

    // When the round reaches the action
    await consentAndStore(round);
    await round.closed;

    // Then the site hears the round was cancelled and nothing was kept
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(await round.stored.list()).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'cancelled', reason: 'phone' }]);
  });

  it('As a user whose action failed, I see the failure with Try again, retry and the site gets its result', async () => {
    // Given an action that fails once at a step that may be tried again
    const round = await startRound({
      failures: [new SiteRoundFailure({ step: 'chain', retry: true, message: 'The chain is out of reach' })],
    });
    await consentAndStore(round);
    await round.waitForView('site-failed');
    const failed = { screen: round.flow.screen.get(), posts: [...round.posts], errors: round.errors.length };

    // When the user retries
    await round.flow.retry();
    await round.closed;

    // Then the failure showed for the route with Try again and nothing sent, and the retry ran the action again
    expect(failed).toEqual({
      screen: { view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: true },
      posts: [],
      errors: 1,
    });
    expect(round.runs).toHaveLength(2);
    expect(getResult(round.posts).result).toEqual(RESULT);
    expect(round.metrics.counted('test.site_round')).toEqual([
      { outcome: 'error', reason: 'chain' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });

  it('As a user whose action failed past trying again, I see the failure without Try again and a Retry does nothing', async () => {
    // Given an action that fails at a step that may not be tried again
    const round = await startRound({
      failures: [new SiteRoundFailure({ step: 'chain', retry: false, message: 'Another network' })],
    });
    await consentAndStore(round);
    await round.waitForView('site-failed');

    // When a Retry is asked anyway
    await round.flow.retry();

    // Then the failure shows without Try again, the action ran only once and the site heard nothing
    expect(round.flow.screen.get()).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: false });
    expect(round.runs).toHaveLength(1);
    expect(round.posts).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'error', reason: 'chain' }]);
  });

  it('As a user whose action failed for a reason it does not name, I start the round and see the failure with Try again, counted for the action', async () => {
    // Given an action that throws an error of its own
    const round = await startRound({ failures: [new Error('Something broke')] });

    // When the round reaches the action
    await consentAndStore(round);
    await round.waitForView('site-failed');

    // Then the failure shows with Try again, is reported and counted for the action, and the site heard nothing
    expect(round.flow.screen.get()).toEqual({ view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: true });
    expect(round.errors).toHaveLength(1);
    expect(round.posts).toEqual([]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'error', reason: 'action' }]);
  });

  it('As a user, I press confirm before the action asks for one and the press goes nowhere', async () => {
    // Given an action that runs until the test ends it
    const round = await startRound({ held: true });
    await consentAndStore(round);
    const run = await round.waitForRun();
    const settled: string[] = [];

    // When the user presses confirm before the action asks, then the action asks and the user presses again
    round.flow.confirm();
    const asked = run.input.confirmed();
    void asked.then(() => settled.push('asked'));
    const witness = Promise.resolve().then(() => settled.push('witness'));
    await witness;
    round.flow.confirm();
    await asked;

    // Then the ask settled only with the press made while it was pending
    expect(settled).toEqual(['witness', 'asked']);
  });

  it('As a user, I press confirm after the action showed another view and only its next ask settles', async () => {
    // Given an action that asks for a confirm and then shows another view
    const round = await startRound({ held: true });
    await consentAndStore(round);
    const run = await round.waitForRun();
    const settled: string[] = [];
    const first = run.input.confirmed();
    void first.then(
      () => settled.push('first'),
      () => settled.push('first rejected'),
    );
    run.input.show({ view: 'site-signing', origin: SITE_ORIGIN, route: 'sign' });

    // When the user presses confirm, then the action asks again and the user presses once more
    round.flow.confirm();
    const second = run.input.confirmed();
    void second.then(() => settled.push('second'));
    round.flow.confirm();
    await second;

    // Then the first ask rejected as the other view showed, and only the second settled with a press
    expect(settled).toEqual(['first rejected', 'second']);
  });

  it('As a user, I cancel while the action waits for my confirm and its wait ends', async () => {
    // Given an action that waits for the user's confirm
    const round = await startRound({ held: true });
    await consentAndStore(round);
    const run = await round.waitForRun();
    const asked = run.input.confirmed();

    // When the user cancels
    round.flow.cancel();

    // Then the wait rejects and the site heard only the cancel
    await expect(asked).rejects.toThrow();
    expect(round.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
  });
});

describe('site round of a group', () => {
  it('As a user on a new site of a group, I consent naming its registrable domain and the site gets a grant of the group', async () => {
    // Given a site that asks under a group token, with no grant kept
    const round = await startRound({ groupToken: GROUP_TOKEN });

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(round);
    await round.closed;

    // Then the consent named the group's registrable domain, the action ran for the main account, and the site got a
    // new token for a grant of the group
    expect(round.screens).toContainEqual({ view: 'consent', origin: SITE_ORIGIN, group: 'my-site.com' });
    expect(round.runs.map(run => run.input.main)).toEqual([MAIN_ACCOUNT]);
    expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
    expect(await round.stored.list()).toEqual([
      {
        token: NEW_SITE_TOKEN,
        origin: SITE_ORIGIN,
        owner: MAIN_OWNER,
        firstUsedAt: ROUND_NOW,
        lastUsedAt: ROUND_NOW,
        group: { registrable: 'my-site.com', token: GROUP_TOKEN, origins: [SITE_ORIGIN] },
      },
    ]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'granted', reason: 'group' }]);
  });

  it("As a site on another origin of a group, I send the group's token and skip consent, and my origin joins the grant", async () => {
    // Given a grant another origin of the group made, whose token this origin sends with the group token
    const round = await startRound({
      origin: SHOP,
      siteToken: SITE_TOKEN,
      groupToken: GROUP_TOKEN,
      grants: [createGroupGrant('my-site.com')],
    });

    // When the window flow says a sign-in is stored
    await round.waitForView('window');
    round.storeSignIn();
    await round.closed;

    // Then no consent showed, the action ran, the site kept its token and the grant lists both origins
    expect(round.readViews()).not.toContain('consent');
    expect(round.runs).toHaveLength(1);
    expect(getResult(round.posts).site_token).toBeUndefined();
    expect(await round.stored.list()).toEqual([
      createGroupGrant('my-site.com', {
        lastUsedAt: ROUND_NOW,
        group: { registrable: 'my-site.com', token: GROUP_TOKEN, origins: [SITE_ORIGIN, SHOP] },
      }),
    ]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'granted', reason: 'group' }]);
  });

  it.each([
    {
      name: 'a grant of another registrable domain',
      origin: SITE_ORIGIN,
      registrable: 'my-site.com',
      grantOrigin: 'https://other.com',
      grantRegistrable: 'other.com',
    },
    {
      name: 'a grant of a github.io sibling',
      origin: 'https://bob.github.io',
      registrable: 'bob.github.io',
      grantOrigin: 'https://alice.github.io',
      grantRegistrable: 'alice.github.io',
    },
    {
      name: 'a grant of a 0.bg sibling',
      origin: 'https://y.0.bg',
      registrable: 'y.0.bg',
      grantOrigin: 'https://x.0.bg',
      grantRegistrable: 'x.0.bg',
    },
  ])(
    'As a site of a group sending the token of $name, I am asked for consent and get a grant of my own',
    async ({ origin, registrable, grantOrigin, grantRegistrable }) => {
      // Given a group grant of the same group token under another registrable domain, whose token the site sends
      const round = await startRound({
        origin,
        siteToken: SITE_TOKEN,
        groupToken: GROUP_TOKEN,
        grants: [createGroupGrant(grantRegistrable, { origin: grantOrigin })],
      });

      // When the user consents and the window flow says a sign-in is stored
      await consentAndStore(round);
      await round.closed;

      // Then the consent named the site's own registrable domain, and the site got a new token for a grant apart from
      // the other
      expect(round.screens).toContainEqual({ view: 'consent', origin, group: registrable });
      expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
      expect((await round.stored.list()).map(grant => grant.group?.registrable).sort()).toEqual(
        [grantRegistrable, registrable].sort(),
      );
    },
  );

  it.each<{ name: string; options: StartRoundParams }>([
    {
      name: 'a group grant without a group token',
      options: { siteToken: SITE_TOKEN, grants: [createGroupGrant('my-site.com')] },
    },
    {
      name: 'a grant of no group with a group token',
      options: { siteToken: SITE_TOKEN, groupToken: GROUP_TOKEN, grants: [createGrant()] },
    },
  ])('As a site sending the token of $name, I sign in and am asked for consent', async ({ options }) => {
    // Given a grant whose token the site sends, of a group the request does not name the same way
    const round = await startRound(options);

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(round);
    await round.closed;

    // Then the site got a new token
    expect(getResult(round.posts).site_token).toBe(NEW_SITE_TOKEN);
  });

  it.each([
    { name: 'on a public suffix', origin: 'https://github.io', self: SELF },
    { name: "on the window's own registrable domain", origin: 'https://my-app.dot.li', self: SELF },
    { name: 'beside a window on a subdomain', origin: 'https://my-app.dot.li', self: 'https://signin.dot.li' },
  ])(
    'As a site of a group $name, I ask to sign in and am refused with bad_request before any consent',
    async ({ origin, self }) => {
      // Given a site that asks under a group token from an origin no group may have
      const round = await startRound({ origin, self, groupToken: GROUP_TOKEN });

      // When the round judges the request
      await round.closed;

      // Then the site was refused as a bad request with no consent shown and nothing kept or reported
      expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
      expect(round.readViews()).not.toContain('consent');
      expect(round.runs).toEqual([]);
      expect(await round.stored.list()).toEqual([]);
      expect(round.errors).toEqual([]);
      expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
    },
  );

  it('As a site whose group is refused, I start a round while the grants store fails and only the refusal is counted', async () => {
    // Given a site on a public suffix that sends a token and a group token, and a grants store whose read fails
    const round = await startRound({
      origin: 'https://github.io',
      siteToken: SITE_TOKEN,
      groupToken: GROUP_TOKEN,
      readFails: true,
    });

    // When the round judges the request and closes
    await round.closed;

    // Then the site was refused as a bad request, and only the refusal was counted, with nothing reported
    expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(round.metrics.counted('test.site_round')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
    expect(round.errors).toEqual([]);
  });

  it('As a site of a group whose window cannot load the suffix list, I am refused with bad_request and the failure is reported', async () => {
    // Given a window whose Public Suffix List does not load
    const groups: SiteGroups = { registrable: () => Promise.reject(new Error('The list did not load')) };
    const round = await startRound({ groupToken: GROUP_TOKEN, groups });

    // When the round judges the request
    await round.closed;

    // Then the site was refused as a bad request, and the load was reported and counted
    expect(round.posts).toEqual([{ type: 'dotli:s:refused', reason: 'bad_request' }]);
    expect(round.readViews()).not.toContain('consent');
    expect(round.errors).toHaveLength(1);
    expect(round.metrics.counted('test.site_round')).toEqual([
      { outcome: 'error', reason: 'group_list' },
      { outcome: 'refused', reason: 'bad_request' },
    ]);
  });

  it('As a user, I cancel one round of a group during its save while another round of the group saved and the group keeps the one grant', async () => {
    // Given round A of the group, whose grant is being saved, and round B of the group on another origin, which saved
    // its grant meanwhile and sent its token
    const otherToken = base64urlnopad.encode(new Uint8Array(32).fill(3));
    const store = createSiteGrantStore({ idb: createMemorySiteGrantsIdb() });
    const gate = createDeferred<undefined>();
    const roundA = await startRound({ store, groupToken: GROUP_TOKEN, saveGate: gate.promise });
    await consentAndStore(roundA);
    await roundA.waitForSaving();
    const roundB = await startRound({ store, origin: SHOP, groupToken: GROUP_TOKEN, newToken: otherToken });
    await consentAndStore(roundB);
    await roundB.closed;

    // When the user cancels round A and its save then commits
    roundA.flow.cancel();
    gate.resolve(undefined);
    // A Retry queues behind the running step, so it resolves once the save's end was handled.
    await roundA.flow.retry();

    // Then round A's site heard only the cancel, and the group keeps the one grant round B's site holds, with both
    // origins
    expect(roundA.posts).toEqual([{ type: 'dotli:s:cancelled' }]);
    expect(getResult(roundB.posts).site_token).toBe(otherToken);
    expect(await store.list()).toEqual([
      {
        token: otherToken,
        origin: SHOP,
        owner: MAIN_OWNER,
        firstUsedAt: ROUND_NOW,
        lastUsedAt: ROUND_NOW,
        group: { registrable: 'my-site.com', token: GROUP_TOKEN, origins: [SHOP, SITE_ORIGIN] },
      },
    ]);
  });
});
