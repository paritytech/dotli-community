// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's round in the session window, whatever the site asked for. It asks the user's consent unless the site's token
// names a grant of this origin, or of the site's group, has the reused window flow sign in or resume a sign-in, runs the
// route's action for the main account, keeps the grant and answers the site once. The main account comes from the
// window core's own report, never the saved copy, and the window flow tells the round only that a sign-in is stored.
// The round hands the main account to the action and never sends it, so nothing of the session itself, nor of a local
// wallet, reaches the site.

import { createReporter, defineCount, type CountAttributes } from '@dotli/metrics';
import { computed, type ReadableAtom } from 'nanostores';
import { createStateMachine, isShallowEqual, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import type { SiteGrant, SiteGrantStore } from '@dotli/storage';
import type { Responder, ResponderState } from '../sessionHandoff/createResponder.js';
import type { RefusalReason } from '../sessionHandoff/sessionMessages.js';
import { reportWalletFailure } from '../walletFailure.js';
import { MainAccountError, type MainAccount } from './mainAccount.js';
import type { DisplayAccount } from './toDisplayAccount.js';
import type { DisplayCall } from './toDisplayCall.js';
import type { SiteGroups } from './createSiteGroups.js';
import { reportSiteFailure, SITE_ROUND_STEP } from './reportSiteFailure.js';
import {
  getGrantReason,
  isAnsweringGrant,
  isUnsentGrantForgotten,
  keepGrant,
  lookUpSite,
  type GrantKeep,
  type GrantLookup,
  type GroupLookup,
  type SiteGroup,
} from './siteRoundGrants.js';
import { SiteRoundFailure, type SiteRoundRefusal } from './siteRoundErrors.js';
import type { SiteRoundWord, SiteRoute } from './siteRouteMetrics.js';

const report = createReporter({ flow: 'wallet' });

/** Count. A transition of a site's round threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const siteRoundTransitionMetric = defineCount<'error'>('session_pages.site_round_transition');

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

/** An action's metric as the round counts on it: the action's result outcomes and the round's own words. */
type SiteMetric<Outcome extends string> = {
  /** The metric's name, since the round's failure reporters take the metric whole. */
  readonly name: string;
  /** Counts one outcome of the round with its reason. Never throws. */
  readonly count: (
    attributes: Omit<CountAttributes<SiteRoundWord>, 'outcome'> & { outcome: Outcome | SiteRoundWord },
  ) => void;
};

/** Where a site's action stands. The round shows `working` and ends or fails on the others. */
export type SiteActionState<Result> =
  | { kind: 'idle' }
  | { kind: 'working'; screen: SiteActionScreen }
  | { kind: 'done'; result: Result }
  | { kind: 'refused'; refusal: SiteRoundRefusal }
  | { kind: 'rejected' }
  | { kind: 'failed'; failure: SiteRoundFailure };

/** What a route does for the main account once the round has the user's grant. */
export type SiteAction<Result, Outcome extends string> = {
  /** The route the action runs on, which the round's views are named for. */
  route: SiteRoute;
  /** The count every outcome of the round goes to. */
  metric: SiteMetric<Outcome>;
  /** The outcome `result` counts as. Never throws. */
  outcome(result: Result): Outcome;
  /** Where the action stands, which the round follows while it runs the action. */
  state: ReadableAtom<SiteActionState<Result>>;
  /**
   * Starts what the action needs before the user's grant, such as opening its chain. Called once as the round starts.
   * Starts nothing that reaches the phone or the site.
   */
  prepare(): void;
  /** Runs the route for `main` from `idle` or `failed`. Ignored in any other state. */
  start(main: MainAccount): void;
  /** Confirms the view the action asks to confirm. Ignored while it asks nothing. */
  confirm(): void;
  /** Lets go of all the action holds, once the round ends. Safe to call twice. */
  end(): void;
  /** Resolves once the action has no work in flight. */
  await(): Promise<void>;
};

export type SiteRoundParams<Result, Outcome extends string> = {
  /** The site's request the round answers. */
  request: SiteRoundRequest;
  /** The vetted opener's origin, the site the round answers. */
  origin: string;
  /** Answers the site, and says when the round is answered. */
  responder: Pick<Responder<unknown>, 'send' | 'refuse' | 'cancel' | 'state'>;
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
   * is the round's own, so a window flow that closes the window cancels a round still open. Calls `failed` when the
   * flow cannot start.
   */
  startWindowFlow: (stored: () => void, close: () => void, failed: (error: unknown) => void) => void;
  /** The time a grant's first and last use are stamped with. */
  now: () => number;
  /** A new grant's site token. */
  randomToken: () => string;
  /** Closes the window. */
  close: () => void;
  /** What the route does once the round has the user's grant. */
  action: SiteAction<Result, Outcome>;
};

/** A site's round: its view and what the user does on it. */
export type SiteRound = ReturnType<typeof createSiteRound>;

/** What the round knows of the request once its group is judged. */
type Facts = {
  /** The request's group, or null for a site of no group. */
  group: SiteGroup | null;
  /** The grant the site's token names for this origin or its group, until it proves to be another main account's. */
  known: SiteGrant | null;
};

/**
 * Where the round is. It judges the site's group while it reads the grant, asks consent, has the window flow sign in,
 * reads the main account, runs the action, keeps the grant and answers the site once. `abandoning` and
 * `forgettingUnsent` wait out the grant of a round the user left while it was kept.
 */
type RoundState<Result> =
  | { kind: 'starting' }
  | { kind: 'lookingUp' }
  | (Facts & { kind: 'consenting'; account: MainAccount | null })
  | (Facts & {
      kind: 'signingIn';
      /** This start of the window flow, so a flow an earlier Try again started is told apart. */
      flow: object;
    })
  | (Facts & { kind: 'readingAccount'; reading: AbortController })
  | { kind: 'forgettingStale'; group: SiteGroup | null; main: MainAccount }
  | (Facts & { kind: 'acting'; main: MainAccount; stop: () => void; screen: SiteScreen })
  | (Facts & { kind: 'keepingGrant'; result: Result; screen: SiteScreen })
  | { kind: 'abandoning'; screen: SiteScreen }
  | { kind: 'forgettingUnsent'; screen: SiteScreen }
  | { kind: 'sent'; stop: () => void; screen: SiteScreen }
  | (Facts & { kind: 'failed'; failure: SiteRoundFailure; retry: 'resume' | 'signIn' })
  | { kind: 'ended'; screen: SiteScreen };

/** The states of a round that has not ended yet, which a cancel ends. */
type OpenKind =
  | 'starting'
  | 'lookingUp'
  | 'consenting'
  | 'signingIn'
  | 'readingAccount'
  | 'forgettingStale'
  | 'acting'
  | 'keepingGrant'
  | 'failed';

type RoundEvent<Result> =
  | { kind: 'started' }
  | { kind: 'lookedUp'; group: GroupLookup; grant: GrantLookup }
  | { kind: 'consented' }
  | { kind: 'declined' }
  | { kind: 'stored'; flow: object }
  | { kind: 'flowFailed'; flow: object; error: unknown }
  | { kind: 'accountRead'; main: MainAccount }
  | { kind: 'accountFailed'; error: unknown }
  | { kind: 'staleForgotten' }
  | { kind: 'staleForgetFailed'; error: unknown }
  | { kind: 'actionMoved'; state: SiteActionState<Result> }
  | { kind: 'actionSettled' }
  | { kind: 'confirmed' }
  | GrantKeep
  | { kind: 'unsentForgotten' }
  | { kind: 'unsentForgetFailed'; error: unknown }
  | { kind: 'responderMoved'; state: ResponderState }
  | { kind: 'retried' }
  | { kind: 'cancelled' };

/** How a round that sends no result answers the site: refused, or told the user left on the page or on the phone. */
type RoundAnswer = { kind: 'refused'; reason: RefusalReason } | { kind: 'cancelled'; by: 'page' | 'phone' };

/** `refused`, `cancelled` and `sent` each count the round's outcome and answer the site. */
type RoundEffect<Result> =
  | RoundAnswer
  | { kind: 'sent'; result: Result; siteToken: string | undefined; reason: string }
  | { kind: 'actionPrepared' }
  | { kind: 'actionStarted'; main: MainAccount }
  | { kind: 'actionConfirmed' }
  | { kind: 'actionEnded' }
  | { kind: 'closed' }
  | { kind: 'refusalFailed'; refusal: SiteRoundRefusal }
  | {
      kind: 'grantMissed';
      error: unknown;
      reason: 'grant_read' | 'grant_forget' | 'grant_touch' | 'grant' | 'group_list';
    }
  | { kind: 'failed'; failure: SiteRoundFailure };

/**
 * Starts a site's round for `request`, which judges the site's group and looks up its grant at once. The round answers
 * the site once through `responder` and closes the window once it ends.
 */
export function createSiteRound<Result, Outcome extends string>({
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
}: SiteRoundParams<Result, Outcome>) {
  type Machine = MachineTypes<RoundState<Result>, RoundEvent<Result>, RoundEffect<Result>>;

  const { route, metric } = action;
  const signing: SiteActionScreen = { view: 'site-signing', origin, route };

  const cancelRound: HandlerOf<Machine, OpenKind, 'cancelled'> = (state, _event, transition) => {
    endRound(state, { kind: 'cancelled', by: 'page' }, transition);
  };
  /** Closes the window again for a round that already ended. */
  const closeAgain: HandlerOf<Machine, 'abandoning' | 'forgettingUnsent' | 'ended', 'cancelled'> = (
    _state,
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'closed' });
  };

  const machine = createStateMachine<Machine>({
    initial: { kind: 'starting' },
    handlers: {
      starting: {
        started(_state, _event, { emitState, emitSideEffect, update }) {
          emitState({ kind: 'lookingUp' });
          // One event carries both, so a refused group never reports a failed read.
          update(
            lookUpSite({ request, origin, self, grants, groups }).then(({ group, grant }) => ({
              kind: 'lookedUp',
              group,
              grant,
            })),
          );
          emitSideEffect({ kind: 'actionPrepared' });
        },
        cancelled: cancelRound,
      },
      lookingUp: {
        lookedUp(state, { group, grant }, transition) {
          switch (group.kind) {
            case 'none':
              askOrSignIn(null, grant, transition);
              return;
            case 'read':
              // A group on a public suffix, an address or the window's own registrable domain is refused.
              if (group.registrable === null || group.registrable === group.own) {
                endRound(state, { kind: 'refused', reason: 'bad_request' }, transition);
                return;
              }
              askOrSignIn({ registrable: group.registrable, token: group.token }, grant, transition);
              return;
            case 'failed':
              transition.emitSideEffect({ kind: 'grantMissed', error: group.error, reason: 'group_list' });
              endRound(state, { kind: 'refused', reason: 'bad_request' }, transition);
              return;
          }
        },
        cancelled: cancelRound,
      },
      consenting: {
        consented({ group, known, account }, _event, transition) {
          if (account === null) {
            startFlow({ group, known }, transition);
            return;
          }
          startAction({ group, known }, account, transition);
        },
        declined(state, _event, transition) {
          endRound(state, { kind: 'refused', reason: 'declined' }, transition);
        },
        cancelled: cancelRound,
      },
      signingIn: {
        stored({ group, known, flow }, event, transition) {
          if (event.flow !== flow) {
            return;
          }
          readAccount({ group, known }, transition);
        },
        flowFailed({ group, known, flow }, event, { emitState, emitSideEffect }) {
          if (event.flow !== flow) {
            return;
          }
          const failure = new SiteRoundFailure({
            step: 'action',
            retry: true,
            message: 'The site round failed',
            cause: event.error,
          });
          emitState({ kind: 'failed', group, known, failure, retry: 'signIn' });
          emitSideEffect({ kind: 'failed', failure });
        },
        cancelled: cancelRound,
      },
      readingAccount: {
        accountRead({ group, known }, { main }, transition) {
          if (known !== null && known.owner !== main.owner) {
            // Another main account's grant, which this one never uses again.
            transition.emitState({ kind: 'forgettingStale', group, main });
            transition.update(
              grants.forget(known.token).then(
                () => ({ kind: 'staleForgotten' }),
                (error: unknown) => ({ kind: 'staleForgetFailed', error }),
              ),
            );
            return;
          }
          startAction({ group, known }, main, transition);
        },
        accountFailed({ group, known }, { error }, { emitState, emitSideEffect }) {
          const failure = new SiteRoundFailure({
            step: 'main_account',
            retry: true,
            message: 'The main account could not be read',
            cause: error,
          });
          // A stored session that is gone comes back only with a new sign-in.
          const retry = error instanceof MainAccountError && error.kind === 'signed_out' ? 'signIn' : 'resume';
          emitState({ kind: 'failed', group, known, failure, retry });
          emitSideEffect({ kind: 'failed', failure });
        },
        cancelled: cancelRound,
      },
      forgettingStale: {
        staleForgotten({ group, main }, _event, { emitState }) {
          emitState({ kind: 'consenting', group, known: null, account: main });
        },
        staleForgetFailed({ group, main }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'consenting', group, known: null, account: main });
          emitSideEffect({ kind: 'grantMissed', error, reason: 'grant_forget' });
        },
        cancelled: cancelRound,
      },
      acting: {
        actionMoved(state, { state: moved }, transition) {
          switch (moved.kind) {
            case 'idle':
              return;
            case 'working':
              transition.emitState({ ...state, screen: moved.screen });
              // No state handles `actionSettled`. It is sent so that the round's `await()` covers the action's work.
              transition.update(action.await().then(() => ({ kind: 'actionSettled' })));
              return;
            case 'done': {
              state.stop();
              const { group, known, main, screen } = state;
              transition.emitState({ kind: 'keepingGrant', group, known, result: moved.result, screen });
              transition.update(keepGrant({ grants, origin, group, known, owner: main.owner, at: now(), randomToken }));
              return;
            }
            case 'refused':
              if (moved.refusal.cause !== undefined) {
                transition.emitSideEffect({ kind: 'refusalFailed', refusal: moved.refusal });
              }
              endRound(state, { kind: 'refused', reason: moved.refusal.reason }, transition);
              return;
            case 'rejected':
              endRound(state, { kind: 'cancelled', by: 'phone' }, transition);
              return;
            case 'failed': {
              state.stop();
              const { group, known } = state;
              transition.emitState({ kind: 'failed', group, known, failure: moved.failure, retry: 'resume' });
              transition.emitSideEffect({ kind: 'failed', failure: moved.failure });
              return;
            }
          }
        },
        confirmed(_state, _event, { emitSideEffect }) {
          emitSideEffect({ kind: 'actionConfirmed' });
        },
        cancelled: cancelRound,
      },
      keepingGrant: {
        grantKept(state, { kept }, transition) {
          sendResult(state, kept?.token, transition);
        },
        grantKeepFailed(state, { error, reason }, transition) {
          // Reported while the site still gets its result.
          transition.emitSideEffect({ kind: 'grantMissed', error, reason });
          sendResult(state, undefined, transition);
        },
        cancelled: cancelRound,
      },
      abandoning: {
        grantKept({ screen }, { kept }, { emitState, emitSideEffect, update }) {
          // The round ended while the grant was kept, so this site holds no token for it.
          if (kept !== null && isUnsentGrantForgotten(kept)) {
            emitState({ kind: 'forgettingUnsent', screen });
            update(
              grants.forget(kept.token).then(
                () => ({ kind: 'unsentForgotten' }),
                (error: unknown) => ({ kind: 'unsentForgetFailed', error }),
              ),
            );
            return;
          }
          emitState({ kind: 'ended', screen });
          emitSideEffect({ kind: 'closed' });
        },
        grantKeepFailed({ screen }, { error, reason }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended', screen });
          // Reported even once the round ended, since only the view and the answer depend on whether it did.
          emitSideEffect({ kind: 'grantMissed', error, reason });
          emitSideEffect({ kind: 'closed' });
        },
        cancelled: closeAgain,
      },
      forgettingUnsent: {
        unsentForgotten({ screen }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended', screen });
          emitSideEffect({ kind: 'closed' });
        },
        unsentForgetFailed({ screen }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended', screen });
          emitSideEffect({ kind: 'grantMissed', error, reason: 'grant_forget' });
          emitSideEffect({ kind: 'closed' });
        },
        cancelled: closeAgain,
      },
      sent: {
        responderMoved({ stop, screen }, { state }, { emitState, emitSideEffect }) {
          // A window restored from the back-forward cache meanwhile is answered only with its next vetting.
          if (state.kind !== 'answered') {
            return;
          }
          stop();
          emitState({ kind: 'ended', screen });
          emitSideEffect({ kind: 'closed' });
        },
        cancelled({ stop, screen }, _event, { emitState, emitSideEffect }) {
          stop();
          emitState({ kind: 'ended', screen });
          emitSideEffect({ kind: 'closed' });
        },
      },
      failed: {
        retried({ group, known, failure, retry }, _event, transition) {
          if (!failure.retry) {
            return;
          }
          switch (retry) {
            case 'resume':
              readAccount({ group, known }, transition);
              return;
            case 'signIn':
              startFlow({ group, known }, transition);
              return;
          }
        },
        cancelled: cancelRound,
      },
      ended: {
        cancelled: closeAgain,
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'refused':
          metric.count({ outcome: 'refused', reason: effect.reason });
          report.log.event('site round refused', { reason: effect.reason });
          responder.refuse(effect.reason);
          return;
        case 'cancelled':
          if (effect.by === 'phone') {
            report.log.event('site round rejected on the phone');
          }
          metric.count({ outcome: 'cancelled', reason: effect.by });
          responder.cancel();
          return;
        case 'sent':
          metric.count({ outcome: action.outcome(effect.result), reason: effect.reason });
          report.log.event('site round sent its result');
          responder.send(effect.result, { siteToken: effect.siteToken });
          return;
        case 'actionPrepared':
          action.prepare();
          return;
        case 'actionStarted':
          action.start(effect.main);
          return;
        case 'actionConfirmed':
          action.confirm();
          return;
        case 'actionEnded':
          action.end();
          return;
        case 'closed':
          close();
          return;
        case 'refusalFailed':
          // The `refused` count is its outcome.
          reportWalletFailure(effect.refusal, {
            what: `site round ${effect.refusal.reason}`,
            step: SITE_ROUND_STEP,
            reason: effect.refusal.reason,
          });
          return;
        case 'grantMissed':
          reportWalletFailure(effect.error, {
            what: effect.reason === 'group_list' ? 'site round group list' : `site round ${effect.reason}`,
            step: SITE_ROUND_STEP,
            reason: effect.reason,
            metric,
          });
          return;
        case 'failed':
          reportSiteFailure(effect.failure, metric);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: siteRoundTransitionMetric,
        message: '[dot.li] A site round transition threw',
      });
    },
  });
  const screen = computed(machine.state, toScreen);
  screen.eq = isShallowEqual;
  machine.update({ kind: 'started' });

  return {
    /** What the window shows for the site. */
    screen,
    /** Goes on from the consent view, once per showing. Never rejects. */
    consent(): Promise<void> {
      machine.update({ kind: 'consented' });
      return machine.await();
    },
    /** Refuses the site from the consent view and closes the window. */
    decline(): void {
      machine.update({ kind: 'declined' });
    },
    /** Confirms what the action asked to confirm. Does nothing while it asks nothing. */
    confirm(): void {
      machine.update({ kind: 'confirmed' });
    },
    /** Runs the round again from a failed view that offers Try again. Never rejects. */
    retry(): Promise<void> {
      machine.update({ kind: 'retried' });
      return machine.await();
    },
    /** Tells the site the user left, unless the round already ended, and closes the window. */
    cancel(): void {
      machine.update({ kind: 'cancelled' });
    },
  };

  function toScreen(state: RoundState<Result>): SiteScreen {
    switch (state.kind) {
      case 'starting':
      case 'lookingUp':
      case 'readingAccount':
      case 'forgettingStale':
        return signing;
      case 'consenting':
        return { view: 'consent', origin, group: state.group?.registrable ?? null };
      case 'signingIn':
        return { view: 'window' };
      case 'failed':
        return { view: 'site-failed', origin, route, retry: state.failure.retry };
      case 'acting':
      case 'keepingGrant':
      case 'abandoning':
      case 'forgettingUnsent':
      case 'sent':
      case 'ended':
        return state.screen;
    }
  }

  /**
   * Ends a round still open with `answer` to the site. A round whose grant is being kept waits for it, so a grant the
   * site never got is forgotten.
   */
  function endRound(
    state: Extract<RoundState<Result>, { kind: OpenKind }>,
    answer: RoundAnswer,
    { emitState, emitSideEffect }: Transition<Machine>,
  ): void {
    switch (state.kind) {
      case 'readingAccount':
        state.reading.abort();
        break;
      case 'acting':
        state.stop();
        break;
      case 'starting':
      case 'lookingUp':
      case 'consenting':
      case 'signingIn':
      case 'forgettingStale':
      case 'keepingGrant':
      case 'failed':
        break;
    }
    const screen = toScreen(state);
    emitState(state.kind === 'keepingGrant' ? { kind: 'abandoning', screen } : { kind: 'ended', screen });
    emitSideEffect(answer);
    emitSideEffect({ kind: 'actionEnded' });
    // The window closes at once, so it shows the site no view of how the round ended.
    emitSideEffect({ kind: 'closed' });
  }

  /** Sends the result once the grant is kept, or could not be, and waits for the site to be answered. */
  function sendResult(
    { group, known, result, screen }: Extract<RoundState<Result>, { kind: 'keepingGrant' }>,
    siteToken: string | undefined,
    { emitState, emitSideEffect, update }: Transition<Machine>,
  ): void {
    const stop = responder.state.listen(state => {
      update({ kind: 'responderMoved', state });
    });
    emitState({ kind: 'sent', stop, screen });
    emitSideEffect({ kind: 'sent', result, siteToken, reason: getGrantReason(group, known) });
    emitSideEffect({ kind: 'actionEnded' });
  }

  /** Has the window flow sign in or resume the stored sign-in. */
  function startFlow({ group, known }: Facts, { emitState, update }: Transition<Machine>): void {
    const flow = {};
    emitState({ kind: 'signingIn', group, known, flow });
    startWindowFlow(
      () => {
        update({ kind: 'stored', flow });
      },
      () => {
        update({ kind: 'cancelled' });
      },
      error => {
        update({ kind: 'flowFailed', flow, error });
      },
    );
  }

  /** From a sign-in the window holds: reads the main account the core reports. */
  function readAccount({ group, known }: Facts, { emitState, update }: Transition<Machine>): void {
    const reading = new AbortController();
    emitState({ kind: 'readingAccount', group, known, reading });
    update(
      mainAccount(reading.signal).then(
        main => ({ kind: 'accountRead', main }),
        (error: unknown) => ({ kind: 'accountFailed', error }),
      ),
    );
  }

  /** Runs the action for `main`, whose moves come back as events. */
  function startAction(
    { group, known }: Facts,
    main: MainAccount,
    { emitState, emitSideEffect, update }: Transition<Machine>,
  ): void {
    const stop = action.state.listen(moved => {
      update({ kind: 'actionMoved', state: moved });
    });
    emitState({ kind: 'acting', group, known, main, stop, screen: signing });
    emitSideEffect({ kind: 'actionStarted', main });
  }

  /**
   * Has the window flow sign in for the grant the site's token names once it answers the request's `group`, else asks
   * the user's consent. A store that cannot be read knows no grant.
   */
  function askOrSignIn(group: SiteGroup | null, lookup: GrantLookup, transition: Transition<Machine>): void {
    switch (lookup.kind) {
      case 'read':
        // Its owner is checked once the main account is read.
        if (lookup.grant !== null && isAnsweringGrant(lookup.grant, group, origin)) {
          startFlow({ group, known: lookup.grant }, transition);
          return;
        }
        transition.emitState({ kind: 'consenting', group, known: null, account: null });
        return;
      case 'failed':
        transition.emitState({ kind: 'consenting', group, known: null, account: null });
        transition.emitSideEffect({ kind: 'grantMissed', error: lookup.error, reason: 'grant_read' });
        return;
    }
  }
}
