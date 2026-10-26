// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A site's round in the session window, whatever the site asked for. It asks the user's consent unless the site's token
// names a grant of this origin, or of the site's group, takes the main session from the reused window flow, runs the
// route's action for the main account, keeps the grant and answers the site once. Of the main session it reads only the
// cached account, which it hands to the action and never sends, so nothing of the session itself, nor of a local
// wallet, reaches the site.

import { m, type MetricOutcome } from '@dotli/metrics';
import {
  blake2b,
  createAsyncTaskPool,
  createSyncStore,
  deferred,
  fromHex,
  log,
  shallowEqual,
  storeStatus,
  toHex,
  untilStatus,
  type ReadableStore,
} from '@dotli/shared';
import type { SiteGrant, SiteGrantStore } from '@dotli/storage';
import type { SessionResult } from '../session-handoff/messages.js';
import type { Responder } from '../session-handoff/responder.js';
import type { RefusalReason } from '../session-handoff/session-protocol.js';
import type { DotliAuthState } from '../session/auth-state.js';
import { parseUiStateCache } from '../session/ui-state.js';
import { reportWalletFailure } from '../wallet-failure.js';
import type { DisplayCall } from './site-call.js';
import type { SiteGroups } from './site-groups.js';
import { groupDerivationIndex, siteDerivationIndex } from './site-signer.js';

/** What the round needs of a site's request, whatever its route. */
export interface SiteRoundRequest {
  round: string;
  siteToken: string | null;
  statement: string | null;
  /** The site's group token, or null for a site of no group. */
  groupToken: string | null;
}

/** The main account an action runs for. The round never sends any of it. */
export interface MainAccount {
  /** Hex of the hash of the main account's public key, whose grants these are. */
  owner: string;
  /** Null for an account with no username to show a site. */
  username: { name: string; kind: 'lite' | 'full' } | null;
  publicKey: Uint8Array;
}

/**
 * The action refuses the site with `reason`. A refusal with a `cause` is a failure, which the round reports, and one
 * without is the site's own input or the user's, which it does not.
 */
export class SiteRoundRefusal extends Error {
  override name = 'SiteRoundRefusal';
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, cause?: unknown) {
    super(`The site's round was refused with ${reason}`, { cause });
    this.reason = reason;
  }
}

/** The step of a round that failed, a closed set so the metric's `reason` tag stays bounded. */
export type SiteStep = 'cache' | 'account' | 'sign' | 'chain' | 'build' | 'submit' | 'grant' | 'action';

/** A step of the round that failed, shown with Try again when `retry` holds. */
export class SiteRoundFailure extends Error {
  override name = 'SiteRoundFailure';
  readonly step: SiteStep;
  readonly retry: boolean;

  constructor(step: SiteStep, retry: boolean, message: string, cause?: unknown) {
    super(message, { cause });
    this.step = step;
    this.retry = retry;
  }
}

const STEP = 'site_round';

/** Reports a failed step of a site's round and counts it as `error` with the step on `metric`. */
export function reportSiteFailure(failure: SiteRoundFailure, metric: string): void {
  reportWalletFailure(failure, { what: `site round ${failure.step}`, step: STEP, reason: failure.step, metric });
}

/**
 * Whether a kept grant whose token never reached the site is forgotten. A group's grant stays, since the user consented
 * and another origin of the group may hold its token.
 */
export function forgetsUnsentGrant(grant: Pick<SiteGrant, 'group'>): boolean {
  return grant.group === undefined;
}

/** The user rejected the action's request, which cancels the round. */
export class SiteRoundRejected extends Error {
  override name = 'SiteRoundRejected';

  constructor(cause?: unknown) {
    super("The site's request was rejected", { cause });
  }
}

/** The round's view while it or its action works, named for the route. */
interface SiteSigningScreen {
  view: 'site-signing';
  origin: string;
  route: 'auth' | 'sign';
}

/**
 * What an action shows while it runs. `site-review` shows the site's call for the user to confirm, and
 * `site-submitting` the transaction on its way, `sent` once the chain has it.
 */
export type SiteActionScreen =
  | SiteSigningScreen
  | { view: 'site-review'; origin: string; call: DisplayCall }
  | { view: 'site-submitting'; origin: string; sent: boolean };

/** What the window shows for a site. `window` while the reused window flow shows its own views. */
export type SiteScreen =
  | {
      view: 'consent';
      origin: string;
      statement: string | null;
      /** The registrable domain of the site's group, or null for a site of no group. */
      group: string | null;
    }
  | { view: 'site-failed'; origin: string; route: 'auth' | 'sign'; retry: boolean }
  | { view: 'window' }
  | SiteActionScreen;

/** What a route does for the main account once the round has the user's grant. */
export interface SiteAction<R> {
  route: 'auth' | 'sign';
  /** The outcome a result counts with. */
  outcome(result: R): MetricOutcome;
  /**
   * The refusal a Cancel answers the site with in place of a cancel, or null for a cancel. Without it, a Cancel is
   * always a cancel. It lets an action whose effect may already stand, such as a transaction the chain has, keep the
   * site from taking a Cancel as nothing done.
   */
  cancelAs?(): RefusalReason | null;
  /**
   * Runs the route for `main` with the site account at derivation `index`, whose key a grant may keep, and resolves
   * with the site's result and the site account's key. It throws a {@link SiteRoundRefusal}, a
   * {@link SiteRoundRejected} or a {@link SiteRoundFailure} to end or fail the round. `confirmed` resolves on the
   * user's confirm on the view shown last, and rejects once another view shows or the round ends. `signal` aborts
   * once the round ends, so the action stops what it still runs.
   */
  run(input: {
    main: MainAccount;
    index: `0x${string}`;
    knownKey: Uint8Array | null;
    show: (screen: SiteActionScreen) => void;
    confirmed: () => Promise<void>;
    signal: AbortSignal;
  }): Promise<{ result: R; publicKey: Uint8Array }>;
}

export interface SiteRoundDeps<R> {
  request: SiteRoundRequest;
  /** The vetted opener's origin, the site the round answers. */
  origin: string;
  /** Answers the site, and says when the round is answered. */
  responder: Pick<Responder<unknown>, 'send' | 'refuse' | 'cancel' | 'state' | 'subscribe'>;
  grants: SiteGrantStore;
  /** The registrable domains a site's group is judged by. */
  groups: SiteGroups;
  /** The window's own origin, whose registrable domain no site's group may have. */
  self: string;
  auth: ReadableStore<DotliAuthState>;
  /** The main store's cached account, read again on a Retry. */
  readUiCache: () => Promise<string | null>;
  /**
   * Starts the window flow that hands over the main session through `deliver`. `close` is the round's own, so a window
   * flow that closes the window cancels a round still open.
   */
  startWindowFlow: (deliver: (result: SessionResult) => void, close: () => void) => void;
  now: () => number;
  randomToken: () => string;
  close: () => void;
  action: SiteAction<R>;
  /** The count the round's outcomes go to. */
  metric: string;
}

export interface SiteRound {
  screen: ReadableStore<SiteScreen>;
  /** Goes on from the consent view, once per showing. */
  consent(): Promise<void>;
  /** Refuses the site from the consent view and closes the window. */
  decline(): void;
  /** Confirms what the action asked to confirm. Does nothing while it asks nothing. */
  confirm(): void;
  /** Runs the round again from a failed view that offers Try again. */
  retry(): Promise<void>;
  /** Tells the site the user left, unless the round already ended, and closes the window. */
  cancel(): void;
}

/** A grants store call whose failure is reported and counted while the round goes on. */
type GrantMiss = 'grant_read' | 'grant_forget' | 'grant_touch';

/** A site's group: its registrable domain and its group token. */
interface SiteGroup {
  registrable: string;
  token: string;
}

/** The main account in a cached UI state. */
function mainAccountOf(uiState: string | null): MainAccount {
  const account = uiState === null ? null : parseUiStateCache(uiState);
  if (account?.publicKey === undefined) {
    throw new SiteRoundFailure('cache', true, 'The main account is not in the session cache');
  }
  let publicKey: Uint8Array;
  try {
    publicKey = fromHex(account.publicKey);
  } catch (error) {
    throw new SiteRoundFailure('cache', true, 'The cached main account has no readable public key', error);
  }
  const owner = toHex(blake2b(publicKey, 32));
  if (account.fullUsername !== undefined && account.fullUsername !== '') {
    return { owner, username: { name: account.fullUsername, kind: 'full' }, publicKey };
  }
  if (account.liteUsername !== undefined && account.liteUsername !== '') {
    return { owner, username: { name: account.liteUsername, kind: 'lite' }, publicKey };
  }
  return { owner, username: null, publicKey };
}

export function createSiteRound<R>(deps: SiteRoundDeps<R>): SiteRound {
  const { request, origin, responder, grants, action, metric } = deps;
  const { route } = action;
  const working: SiteActionScreen = { view: 'site-signing', origin, route };
  const screen = createSyncStore<SiteScreen>('siteRound', working, { equals: shallowEqual });
  // One step at a time, so a second press waits for the first and finds the view it left.
  const steps = createAsyncTaskPool({ poolSize: 1 });
  // Aborted as the round's last word goes out, so nothing after it posts or changes the main store.
  const ended = new AbortController();
  // The request's group once judged, and the site account's index, which stays one through the round.
  let group: SiteGroup | null = null;
  let index = siteDerivationIndex(origin);
  // The grant the site's token names for this origin or its group, until it proves to be another main account's.
  let known: SiteGrant | null = null;
  // The main account once read, which a consent shown after it runs the action for.
  let account: MainAccount | null = null;
  // The confirm the action waits for, on the view it showed last.
  let pending: ReturnType<typeof deferred<undefined>> | null = null;

  /** Rejects the confirm the action waits for, if any, which no press can settle any more. */
  const dropConfirm = (reason: string): void => {
    const wait = pending;
    pending = null;
    wait?.reject(new Error(reason));
  };

  const show = (next: SiteScreen): void => {
    if (!ended.signal.aborted) {
      dropConfirm('The view the confirm was asked on changed');
      screen.set(next);
    }
  };

  const confirmed = (): Promise<void> => {
    if (ended.signal.aborted) {
      return Promise.reject(new Error('The round ended', { cause: ended.signal.reason }));
    }
    const wait = deferred<undefined>();
    pending = wait;
    return wait.promise;
  };

  /** Claims the round's last word for the caller to post, counted once. False once the round ended. */
  const endRound = (outcome: MetricOutcome, reason: string): boolean => {
    if (ended.signal.aborted) {
      return false;
    }
    m.count(metric, { outcome, reason });
    ended.abort();
    dropConfirm('The round ended');
    return true;
  };

  const reportGrantMiss = (error: unknown, reason: GrantMiss): void => {
    reportWalletFailure(error, { what: `site round ${reason}`, step: STEP, reason, metric });
  };

  /** Refuses the site, unless the round already ended. True when this ended it. */
  const refuseSite = (reason: RefusalReason): boolean => {
    if (!endRound('refused', reason)) {
      return false;
    }
    log.event('site round refused', { flow: 'wallet', reason });
    responder.refuse(reason);
    return true;
  };

  /** Refuses the site and closes the window, unless the round already ended. */
  const refuse = (reason: RefusalReason): void => {
    // The window closes at once, so it shows the site no view of the refusal.
    if (refuseSite(reason)) {
      deps.close();
    }
  };

  /** Tells the site the user left, or what the action says a Cancel now means, and closes the window. */
  const cancel = (): void => {
    const reason = action.cancelAs?.() ?? null;
    if (reason !== null) {
      refuseSite(reason);
    } else if (endRound('cancelled', 'page')) {
      responder.cancel();
    }
    deps.close();
  };

  /** The user rejected the action's request on the phone. */
  const rejected = (): void => {
    log.event('site round rejected on the phone', { flow: 'wallet' });
    if (endRound('cancelled', 'phone')) {
      responder.cancel();
    }
    deps.close();
  };

  /**
   * Closes the window once the round is answered, now or with the next vetting of a window restored from the
   * back-forward cache meanwhile, which sends the result it holds.
   */
  const closeOnceAnswered = (): void => {
    if (responder.state().kind === 'answered') {
      deps.close();
      return;
    }
    const stop = responder.subscribe(state => {
      if (state.kind === 'answered') {
        stop();
        deps.close();
      }
    });
  };

  const fail = (failure: SiteRoundFailure): void => {
    // A round that ended shows nothing more, so a failure after it is no failure the user sees.
    if (ended.signal.aborted) {
      return;
    }
    reportSiteFailure(failure, metric);
    show({ view: 'site-failed', origin, route, retry: failure.retry });
  };

  /** Never rejects: a refusal, a rejection or a failure each end or fail the round. */
  const step = (run: () => Promise<void>): Promise<void> =>
    steps.call(run).catch((error: unknown) => {
      if (error instanceof SiteRoundRefusal) {
        if (error.cause !== undefined) {
          // The `refused` count is its outcome.
          reportWalletFailure(error, { what: `site round ${error.reason}`, step: STEP, reason: error.reason });
        }
        refuse(error.reason);
      } else if (error instanceof SiteRoundRejected) {
        rejected();
      } else {
        fail(
          error instanceof SiteRoundFailure
            ? error
            : new SiteRoundFailure('action', true, 'The site round failed', error),
        );
      }
    });

  /**
   * The group the request names, under its origin's registrable domain. Refuses a group on a public suffix, an address
   * or the window's own registrable domain, and one the suffix list could not judge, which is reported.
   */
  const groupOf = async (token: string): Promise<SiteGroup> => {
    const hostname = new URL(origin).hostname;
    const ownHostname = new URL(deps.self).hostname;
    let registrable: string | null;
    let own: string | null;
    try {
      [registrable, own] = await Promise.all([deps.groups.registrable(hostname), deps.groups.registrable(ownHostname)]);
    } catch (error) {
      reportWalletFailure(error, { what: 'site round group list', step: STEP, reason: 'group_list', metric });
      throw new SiteRoundRefusal('bad_request');
    }
    if (registrable === null || registrable === own) {
      throw new SiteRoundRefusal('bad_request');
    }
    return { registrable, token };
  };

  /**
   * Whether `grant` answers the request: one of the request's group, or of this origin for a request of no group. Its
   * owner is checked once the main account is read.
   */
  const answers = (grant: SiteGrant): boolean =>
    group === null
      ? grant.group === undefined && grant.origin === origin
      : grant.group?.registrable === group.registrable && grant.group.token === group.token;

  /** The grant the site's token names, when it answers the request. A store that cannot be read knows none. */
  const lookUp = async (): Promise<SiteGrant | null> => {
    if (request.siteToken === null) {
      return null;
    }
    try {
      const grant = await grants.read(request.siteToken);
      return grant !== null && answers(grant) ? grant : null;
    } catch (error) {
      reportGrantMiss(error, 'grant_read');
      return null;
    }
  };

  const showConsent = (): void => {
    show({ view: 'consent', origin, statement: request.statement, group: group?.registrable ?? null });
  };

  /** Forgets the grant of `token`. A failure is reported and the round goes on. */
  const forgetGrant = async (token: string): Promise<void> => {
    try {
      await grants.forget(token);
    } catch (error) {
      reportGrantMiss(error, 'grant_forget');
    }
  };

  /**
   * Keeps a new grant, or moves a known one's last use on and joins this origin to its group. Resolves with the grant
   * whose token the site gets for a new grant, the group's own when the group already has one, or nothing when the
   * grant was known or could not be kept, which is reported and counted while the site still gets its result.
   */
  const keepGrant = async (
    grant: SiteGrant | null,
    main: MainAccount,
    publicKey: Uint8Array,
  ): Promise<SiteGrant | undefined> => {
    const at = deps.now();
    if (grant !== null) {
      try {
        // A known grant answers the request's group and the main account, so this origin may join it.
        await (group === null ? grants.touch(grant.token, at) : grants.touch(grant.token, at, origin));
      } catch (error) {
        reportGrantMiss(error, 'grant_touch');
      }
      return undefined;
    }
    const kept: SiteGrant = {
      token: deps.randomToken(),
      origin,
      publicKey: toHex(publicKey),
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
      reportWalletFailure(error, { what: 'site round grant', step: STEP, reason: 'grant', metric });
      return undefined;
    }
  };

  /** The reason the round's outcome counts with. */
  const grantReason = (grant: SiteGrant | null): string => {
    if (group !== null) {
      return 'group';
    }
    return grant === null ? 'new' : 'known';
  };

  /** Runs the action, keeps the grant and answers the site. */
  const runAction = async (main: MainAccount): Promise<void> => {
    show(working);
    const grant = known;
    const { result, publicKey } = await action.run({
      main,
      index,
      knownKey: grant === null ? null : fromHex(grant.publicKey),
      show,
      confirmed,
      signal: ended.signal,
    });
    if (ended.signal.aborted) {
      return;
    }
    const kept = await keepGrant(grant, main, publicKey);
    if (endRound(action.outcome(result), grantReason(grant))) {
      responder.send(result, kept?.token);
      log.event('site round sent its result', { flow: 'wallet' });
      closeOnceAnswered();
      return;
    }
    // The round ended while the grant was kept, so this site holds no token for it.
    if (kept !== undefined && forgetsUnsentGrant(kept)) {
      await forgetGrant(kept.token);
    }
    deps.close();
  };

  /** From a main session the window holds: waits until it is connected, reads its account and runs the action. */
  const resume = async (readUiState: () => Promise<string | null>): Promise<void> => {
    show(working);
    await untilStatus(storeStatus(deps.auth), state => state.tag === 'Connected');
    let uiState: string | null;
    try {
      uiState = await readUiState();
    } catch (error) {
      throw new SiteRoundFailure('cache', true, 'The session cache could not be read', error);
    }
    if (ended.signal.aborted) {
      return;
    }
    const main = mainAccountOf(uiState);
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
  };

  const deliver = (result: SessionResult): void => {
    void step(async () => {
      if (ended.signal.aborted) {
        return;
      }
      if (result.session === null) {
        refuse('unsupported_wallet');
        return;
      }
      const { uiState } = result.session;
      await resume(() => Promise.resolve(uiState));
    });
  };

  // Whether the window flow started, so a Retry after it failed to start starts it again rather than waiting for a
  // session nothing will hand over.
  let flowStarted = false;
  const openMainSession = (): void => {
    show({ view: 'window' });
    deps.startWindowFlow(deliver, cancel);
    flowStarted = true;
  };

  void step(async () => {
    if (request.groupToken !== null) {
      group = await groupOf(request.groupToken);
      index = groupDerivationIndex(group.registrable, group.token);
    }
    known = await lookUp();
    if (known === null) {
      showConsent();
    } else {
      openMainSession();
    }
  });

  const shown = (): SiteScreen | null => (ended.signal.aborted ? null : screen.get());

  return {
    screen,
    consent: () =>
      step(async () => {
        if (shown()?.view !== 'consent') {
          return;
        }
        if (account === null) {
          openMainSession();
          return;
        }
        await runAction(account);
      }),
    decline() {
      if (shown()?.view === 'consent') {
        refuse('declined');
      }
    },
    confirm() {
      const wait = pending;
      pending = null;
      wait?.resolve(undefined);
    },
    retry: () =>
      step(async () => {
        const failed = shown();
        if (failed?.view !== 'site-failed' || !failed.retry) {
          return;
        }
        if (flowStarted) {
          await resume(deps.readUiCache);
        } else {
          openMainSession();
        }
      }),
    cancel,
  };
}
