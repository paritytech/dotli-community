// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's round in the session window, whatever the site asked for. It asks the user's consent unless the site's token
// names a grant of this origin, or of the site's group, has the reused window flow sign in or resume a sign-in, runs the
// route's action for the main account, keeps the grant and answers the site once. The main account comes from the
// window core's own report, never the saved copy, and the window flow tells the round only that a sign-in is stored.
// The round hands the main account to the action and never sends it, so nothing of the session itself, nor of a local
// wallet, reaches the site.

import { m, type MetricOutcome } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createSyncStore,
  createDeferred,
  log,
  isShallowEqual,
  waitForStatus,
  type ReadableStore,
} from '@dotli/shared';
import type { SiteGrant, SiteGrantStore } from '@dotli/storage';
import type { Responder } from '../sessionHandoff/createResponder.js';
import type { SessionRoute } from '../sessionHandoff/sessionRoute.js';
import type { RefusalReason } from '../sessionHandoff/sessionMessages.js';
import { reportWalletFailure } from '../walletFailure.js';
import { MainAccountError, type MainAccount } from './createMainAccountSource.js';
import type { DisplayAccount } from './toDisplayAccount.js';
import type { DisplayCall } from './toDisplayCall.js';
import type { SiteGroups } from './createSiteGroups.js';
import { reportSiteFailure, SITE_ROUND_STEP } from './reportSiteFailure.js';
import { SiteRoundFailure, SiteRoundRefusal, SiteRoundRejected } from './siteRoundErrors.js';

/** The routes a site's round runs on: its sign-in and its transaction. */
export type SiteRoute = Extract<SessionRoute, 'auth' | 'sign'>;

/** What the round needs of a site's request, whatever its route. */
export type SiteRoundRequest = {
  round: string;
  siteToken: string | null;
  /** The site's group token, or null for a site of no group. */
  groupToken: string | null;
};

/** The round's view while it or its action works, named for the route. */
type SiteSigningScreen = {
  view: 'site-signing';
  origin: string;
  route: SiteRoute;
};

/**
 * What an action shows while it runs. `site-review` shows the site's call for the user to confirm, and
 * `site-sharing` asks the user to open Polkadot App while the phone is asked for the site account, and `site-approving`
 * shows the transaction while the phone signs it.
 */
export type SiteActionScreen =
  | SiteSigningScreen
  | { view: 'site-review'; origin: string; call: DisplayCall; account: DisplayAccount }
  | { view: 'site-sharing'; origin: string }
  | { view: 'site-approving'; origin: string };

/** What the window shows for a site. `window` while the reused window flow shows its own views. */
export type SiteScreen =
  | {
      view: 'consent';
      origin: string;
      /** The registrable domain of the site's group, or null for a site of no group. */
      group: string | null;
    }
  | { view: 'site-failed'; origin: string; route: SiteRoute; retry: boolean }
  | { view: 'window' }
  | SiteActionScreen;

/** What a route does for the main account once the round has the user's grant. */
export type SiteAction<Result> = {
  /** The route the action runs on, which the round's views are named for. */
  route: SiteRoute;
  /** The outcome a result counts with. */
  outcome(result: Result): MetricOutcome;
  /**
   * Runs the route for `main` and resolves with the site's result. It rejects with a {@link SiteRoundRefusal}, a
   * {@link SiteRoundRejected} or a {@link SiteRoundFailure} to end or fail the round. `confirmed` resolves on the user's
   * confirm on the view shown last, and rejects once another view shows or the round ends. `signal` aborts once the
   * round ends, so the action stops what it still runs.
   */
  run(input: {
    main: MainAccount;
    show: (screen: SiteActionScreen) => void;
    confirmed: () => Promise<void>;
    signal: AbortSignal;
  }): Promise<Result>;
};

export type SiteRoundParams<Result> = {
  /** The site's request the round answers. */
  request: SiteRoundRequest;
  /** The vetted opener's origin, the site the round answers. */
  origin: string;
  /** Answers the site, and says when the round is answered. */
  responder: Pick<Responder<unknown>, 'send' | 'refuse' | 'cancel' | 'state' | 'subscribe'>;
  /** The main store's grants, which the round reads, keeps and forgets. */
  grants: SiteGrantStore;
  /** The registrable domains a site's group is judged by. */
  groups: SiteGroups;
  /** The window's own origin, whose registrable domain no site's group may have. */
  self: string;
  /**
   * The main account the window's core reports, once it reports one. Rejects with a {@link MainAccountError} when the
   * core cannot boot or its session is gone, or once `signal` aborts.
   */
  mainAccount: (signal: AbortSignal) => Promise<MainAccount>;
  /**
   * Starts the window flow that signs in or resumes the stored sign-in, and calls `stored` once one is stored. `close`
   * is the round's own, so a window flow that closes the window cancels a round still open.
   */
  startWindowFlow: (stored: () => void, close: () => void) => void;
  /** The time a grant's first and last use are stamped with. */
  now: () => number;
  /** A new grant's site token. */
  randomToken: () => string;
  /** Closes the window. */
  close: () => void;
  /** What the route does once the round has the user's grant. */
  action: SiteAction<Result>;
  /** The count the round's outcomes go to. */
  metric: string;
};

/** A site's round: its view and what the user does on it. */
export type SiteRound = ReturnType<typeof createSiteRound>;

/** A grants store call whose failure is reported and counted while the round goes on. */
type GrantMiss = 'grant_read' | 'grant_forget' | 'grant_touch';

/** A site's group: its registrable domain and its group token. */
type SiteGroup = {
  registrable: string;
  token: string;
};

/**
 * Starts a site's round for `request`, which judges the site's group and looks up its grant at once. The round answers
 * the site once through `responder` and closes the window once it ends.
 */
export function createSiteRound<Result>({
  request,
  origin,
  responder,
  grants,
  groups,
  self,
  mainAccount,
  startWindowFlow,
  now,
  randomToken,
  close,
  action,
  metric,
}: SiteRoundParams<Result>) {
  const { route } = action;
  const working: SiteActionScreen = { view: 'site-signing', origin, route };
  const screen = createSyncStore<SiteScreen>({ name: 'siteRound', initial: working, equals: isShallowEqual });
  // One step at a time, so a second press waits for the first and finds the view it left.
  const steps = createAsyncTaskPool({ poolSize: 1 });
  // Aborted as the round's last word goes out, so nothing after it posts or changes the main store.
  const ended = new AbortController();
  // The request's group once judged.
  let group: SiteGroup | null = null;
  // The grant the site's token names for this origin or its group, until it proves to be another main account's.
  let known: SiteGrant | null = null;
  // The main account once read, which a consent shown after it runs the action for.
  let account: MainAccount | null = null;
  // The confirm the action waits for, on the view it showed last.
  let pending: ReturnType<typeof createDeferred<undefined>> | null = null;
  // Whether a window flow started that a Try again can go on from. A Try again without one starts the flow, as after
  // a flow that failed to start or a stored session that is gone, which only a new sign-in brings back.
  let flowStarted = false;

  /** Rejects the confirm the action waits for, if any, which no press can settle any more. */
  function dropConfirm(reason: string): void {
    const wait = pending;
    pending = null;
    wait?.reject(new Error(reason));
  }

  function show(next: SiteScreen): void {
    if (!ended.signal.aborted) {
      dropConfirm('The view the confirm was asked on changed');
      screen.set(next);
    }
  }

  function waitForConfirm(): Promise<void> {
    if (ended.signal.aborted) {
      return Promise.reject(new Error('The round ended', { cause: ended.signal.reason }));
    }
    const wait = createDeferred<undefined>();
    pending = wait;
    return wait.promise;
  }

  /** Claims the round's last word for the caller to post, counted once. False once the round ended. */
  function endRound(outcome: MetricOutcome, reason: string): boolean {
    if (ended.signal.aborted) {
      return false;
    }
    m.count(metric, { outcome, reason });
    ended.abort();
    dropConfirm('The round ended');
    return true;
  }

  function reportGrantMiss(error: unknown, reason: GrantMiss): void {
    reportWalletFailure(error, { what: `site round ${reason}`, step: SITE_ROUND_STEP, reason, metric });
  }

  /** Refuses the site and closes the window, unless the round already ended. */
  function refuse(reason: RefusalReason): void {
    if (!endRound('refused', reason)) {
      return;
    }
    log.event('site round refused', { flow: 'wallet', reason });
    responder.refuse(reason);
    // The window closes at once, so it shows the site no view of the refusal.
    close();
  }

  /** Tells the site the user left and closes the window. */
  function cancelRound(): void {
    if (endRound('cancelled', 'page')) {
      responder.cancel();
    }
    close();
  }

  /** Ends the round for the user's rejection of the action's request on the phone. */
  function endRejected(): void {
    log.event('site round rejected on the phone', { flow: 'wallet' });
    if (endRound('cancelled', 'phone')) {
      responder.cancel();
    }
    close();
  }

  /**
   * Closes the window once the round is answered, now or with the next vetting of a window restored from the
   * back-forward cache meanwhile, which sends the result it holds.
   */
  function closeOnceAnswered(): void {
    void waitForStatus(
      { get: responder.state, subscribe: responder.subscribe },
      state => state.kind === 'answered',
    ).then(close);
  }

  function fail(failure: SiteRoundFailure): void {
    // A round that ended shows nothing more, so a failure after it is no failure the user sees.
    if (ended.signal.aborted) {
      return;
    }
    reportSiteFailure(failure, metric);
    show({ view: 'site-failed', origin, route, retry: failure.retry });
  }

  /** Never rejects: a refusal, a rejection or a failure each end or fail the round. */
  function runStep(run: () => Promise<void>): Promise<void> {
    return steps.call(run).catch(handleStepError);
  }

  function handleStepError(error: unknown): void {
    if (error instanceof SiteRoundRefusal) {
      if (error.cause !== undefined) {
        // The `refused` count is its outcome.
        reportWalletFailure(error, {
          what: `site round ${error.reason}`,
          step: SITE_ROUND_STEP,
          reason: error.reason,
        });
      }
      refuse(error.reason);
    } else if (error instanceof SiteRoundRejected) {
      endRejected();
    } else {
      fail(
        error instanceof SiteRoundFailure
          ? error
          : new SiteRoundFailure({ step: 'action', retry: true, message: 'The site round failed', cause: error }),
      );
    }
  }

  /**
   * The group the request names, under its origin's registrable domain. Refuses a group on a public suffix, an address
   * or the window's own registrable domain, and one the suffix list could not judge, which is reported.
   */
  async function judgeGroup(token: string): Promise<SiteGroup> {
    const hostname = new URL(origin).hostname;
    const ownHostname = new URL(self).hostname;
    let registrable: string | null;
    let own: string | null;
    try {
      [registrable, own] = await Promise.all([groups.registrable(hostname), groups.registrable(ownHostname)]);
    } catch (error) {
      reportWalletFailure(error, {
        what: 'site round group list',
        step: SITE_ROUND_STEP,
        reason: 'group_list',
        metric,
      });
      throw new SiteRoundRefusal('bad_request');
    }
    if (registrable === null || registrable === own) {
      throw new SiteRoundRefusal('bad_request');
    }
    return { registrable, token };
  }

  /**
   * Whether `grant` answers the request: one of the request's group, or of this origin for a request of no group. Its
   * owner is checked once the main account is read.
   */
  function isAnsweringGrant(grant: SiteGrant): boolean {
    return group === null
      ? grant.group === undefined && grant.origin === origin
      : grant.group?.registrable === group.registrable && grant.group.token === group.token;
  }

  /** The grant the site's token names, when it answers the request. A store that cannot be read knows none. */
  async function lookUpGrant(): Promise<SiteGrant | null> {
    if (request.siteToken === null) {
      return null;
    }
    try {
      const grant = await grants.read(request.siteToken);
      return grant !== null && isAnsweringGrant(grant) ? grant : null;
    } catch (error) {
      reportGrantMiss(error, 'grant_read');
      return null;
    }
  }

  function showConsent(): void {
    show({ view: 'consent', origin, group: group?.registrable ?? null });
  }

  /** Forgets the grant of `token`. A failure is reported and the round goes on. */
  async function forgetGrant(token: string): Promise<void> {
    try {
      await grants.forget(token);
    } catch (error) {
      reportGrantMiss(error, 'grant_forget');
    }
  }

  /**
   * Keeps a new grant, or moves a known one's last use on and joins this origin to its group. Resolves with the grant
   * whose token the site gets for a new grant, the group's own when the group already has one, or nothing when the
   * grant was known or could not be kept, which is reported and counted while the site still gets its result.
   */
  async function keepGrant(grant: SiteGrant | null, main: MainAccount): Promise<SiteGrant | undefined> {
    const at = now();
    if (grant !== null) {
      try {
        // A known grant answers the request's group and the main account, so this origin may join it.
        await (group === null ? grants.touch(grant.token, at) : grants.touch(grant.token, at, { origin }));
      } catch (error) {
        reportGrantMiss(error, 'grant_touch');
      }
      return undefined;
    }
    const kept: SiteGrant = {
      token: randomToken(),
      origin,
      owner: main.owner,
      firstUsedAt: at,
      lastUsedAt: at,
    };
    try {
      // Kept before the site gets the token, so no site holds a token the main store does not know.
      if (group === null) {
        await grants.save(kept);
        return kept;
      }
      return await grants.saveGroup({ ...kept, group: { ...group, origins: [origin] } });
    } catch (error) {
      // Reported even after the round ended, since only the view and the answer depend on whether it did.
      reportWalletFailure(error, { what: 'site round grant', step: SITE_ROUND_STEP, reason: 'grant', metric });
      return undefined;
    }
  }

  /** The reason the round's outcome counts with. */
  function getGrantReason(grant: SiteGrant | null): string {
    if (group !== null) {
      return 'group';
    }
    return grant === null ? 'new' : 'known';
  }

  /** Runs the action, keeps the grant and answers the site. */
  async function runAction(main: MainAccount): Promise<void> {
    show(working);
    const grant = known;
    const result = await action.run({ main, show, confirmed: waitForConfirm, signal: ended.signal });
    if (ended.signal.aborted) {
      return;
    }
    const kept = await keepGrant(grant, main);
    if (endRound(action.outcome(result), getGrantReason(grant))) {
      responder.send(result, { siteToken: kept?.token });
      log.event('site round sent its result', { flow: 'wallet' });
      closeOnceAnswered();
      return;
    }
    // The round ended while the grant was kept, so this site holds no token for it.
    if (kept !== undefined && isUnsentGrantForgotten(kept)) {
      await forgetGrant(kept.token);
    }
    close();
  }

  /** From a sign-in the window holds: reads the main account the core reports and runs the action. */
  async function resume(): Promise<void> {
    show(working);
    let main: MainAccount;
    try {
      main = await mainAccount(ended.signal);
    } catch (error) {
      if (error instanceof MainAccountError && error.kind === 'signed_out') {
        flowStarted = false;
      }
      throw new SiteRoundFailure({
        step: 'main_account',
        retry: true,
        message: 'The main account could not be read',
        cause: error,
      });
    }
    if (ended.signal.aborted) {
      return;
    }
    account = main;
    if (known !== null && known.owner !== main.owner) {
      // Another main account's grant, which this one never uses again.
      const stale = known;
      known = null;
      await forgetGrant(stale.token);
      showConsent();
      return;
    }
    await runAction(main);
  }

  async function resumeUnlessEnded(): Promise<void> {
    if (!ended.signal.aborted) {
      await resume();
    }
  }

  function handleStored(): void {
    void runStep(resumeUnlessEnded);
  }

  function openMainSession(): void {
    show({ view: 'window' });
    startWindowFlow(handleStored, cancelRound);
    flowStarted = true;
  }

  async function start(): Promise<void> {
    if (request.groupToken !== null) {
      group = await judgeGroup(request.groupToken);
    }
    known = await lookUpGrant();
    if (known === null) {
      showConsent();
    } else {
      openMainSession();
    }
  }

  function getShownScreen(): SiteScreen | null {
    return ended.signal.aborted ? null : screen.get();
  }

  async function goOnFromConsent(): Promise<void> {
    if (getShownScreen()?.view !== 'consent') {
      return;
    }
    if (account === null) {
      openMainSession();
      return;
    }
    await runAction(account);
  }

  async function tryAgain(): Promise<void> {
    const failed = getShownScreen();
    if (failed?.view !== 'site-failed' || !failed.retry) {
      return;
    }
    if (flowStarted) {
      await resume();
    } else {
      openMainSession();
    }
  }

  void runStep(start);

  const shownScreen: ReadableStore<SiteScreen> = screen;

  return {
    /** What the window shows for the site. */
    screen: shownScreen,
    /** Goes on from the consent view, once per showing. Never rejects. */
    consent(): Promise<void> {
      return runStep(goOnFromConsent);
    },
    /** Refuses the site from the consent view and closes the window. */
    decline(): void {
      if (getShownScreen()?.view === 'consent') {
        refuse('declined');
      }
    },
    /** Confirms what the action asked to confirm. Does nothing while it asks nothing. */
    confirm(): void {
      const wait = pending;
      pending = null;
      wait?.resolve(undefined);
    },
    /** Runs the round again from a failed view that offers Try again. Never rejects. */
    retry(): Promise<void> {
      return runStep(tryAgain);
    },
    /** Tells the site the user left, unless the round already ended, and closes the window. */
    cancel(): void {
      cancelRound();
    },
  };
}

/**
 * Whether a kept grant whose token never reached the site is forgotten. A group's grant stays, since the user consented
 * and another origin of the group may hold its token.
 */
export function isUnsentGrantForgotten(grant: Pick<SiteGrant, 'group'>): boolean {
  return grant.group === undefined;
}
