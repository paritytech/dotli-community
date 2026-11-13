// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// When a session window answers its round, and with what. The first vetting names the round's party and origin, which
// the dispatch turns into a round: a refused one gets its refusal alone, and an answerable one waits for what the
// window has to give, a sign-in window's boot or a sign-out window's read.

import type { Network } from '@dotli/config';
import { createReporter } from '@dotli/metrics';
import { waitForStatus } from '@dotli/shared';
import type { SiteRequest } from '../siteSignIn/parseSiteRequest.js';
import type { SiteSignRequest } from '../siteSignIn/parseSiteSignRequest.js';
import type { SignInIntent } from './parseWindowRequest.js';
import type { Responder, ResponderState } from './createResponder.js';
import { dispatchRound, type Round } from './dispatchRound.js';
import type { Party } from './openerRule.js';
import type { SessionRequest } from './readSessionRequest.js';
import type { RefusalReason } from './sessionMessages.js';
import type { SessionRoute } from './sessionRoute.js';
import { SITE_ROUTE_METRICS, type SiteRoute } from '../siteSignIn/siteRouteMetrics.js';

const report = createReporter({ flow: 'wallet' });

/**
 * What the sign-in window runs for its round: dot.li's own flow for the request's intent, or a site's sign-in or
 * transaction for the vetted origin, which the browser vouched for, never one the request names. Each comes with what
 * the boot gave.
 */
export type SignInRound<Booted> =
  | { party: 'first'; intent: SignInIntent; booted: Booted }
  | { party: 'third'; origin: string; request: SiteRequest; booted: Booted }
  | { party: 'third-sign'; origin: string; request: SiteSignRequest; booted: Booted };

/** How the sign-out window answers its round. */
export type SignOutAnswer = {
  /**
   * True once the first vetting found dot.li's own page with a round the window answers, and false once it found a
   * site or a round it refuses, or the window can have no vetting. Never rejects.
   */
  firstParty: Promise<boolean>;
  /**
   * Settles once the round got its answer, or has nobody to answer. Rejects when the refusal or the result could not
   * be posted.
   */
  answered: Promise<void>;
};

/** The origin and party of the responder's first vetting, which stay the round's. */
type Vetted = {
  origin: string;
  party: Party;
};

type RefuseRoundParams = {
  responder: Pick<Responder<unknown>, 'refuse'>;
  party: Vetted['party'];
  reason: RefusalReason;
  /** The route the round came on, which tells a site's transaction from its sign-in. */
  route: SessionRoute;
};

/** The round's request, and the networks the dispatch judges it by. */
type RoundRequest = {
  request: SessionRequest;
  /** The networks this deployment runs. */
  enabled: readonly Network[];
};

type AnswerSignInParams<Booted> = RoundRequest & {
  responder: Pick<Responder<unknown>, 'state' | 'refuse'>;
  /** What the window's boot gives. Rejects when the boot failed. */
  booted: Promise<Booted>;
};

type AnswerSignOutParams = RoundRequest & {
  responder: Pick<Responder<typeof SIGNED_OUT_RESULT>, 'state' | 'refuse' | 'send'>;
  /**
   * Settles once the window read what it ends. Rejects for a sign-out that failed before it read, such as one whose
   * boot failed, which reports its own failure.
   */
  read: Promise<unknown>;
};

type DispatchVettedParams = RoundRequest & {
  responder: Pick<Responder<unknown>, 'refuse'>;
};

/** A round the dispatch answers, with the vetted origin a site's round takes. */
type Answerable = {
  round: Exclude<Round, { kind: 'refuse' }>;
  origin: string;
};

/** What `/s/signout` sends as its result, since it ends a session and has none to hand over. */
export const SIGNED_OUT_RESULT: Readonly<Record<string, never>> = {};

/**
 * Refuses the round with `reason`, leaves a breadcrumb, and counts a site's refusal on the metric of the site route
 * `route` maps to: a transaction's on the sign route, a sign-in's on any other.
 */
export function refuseRound({ responder, party, reason, route }: RefuseRoundParams): void {
  responder.refuse(reason);
  report.log.event('session window refused its round', { party, reason });
  if (party === 'third') {
    SITE_ROUTE_METRICS[getRefusedSiteRoute(route)].count({ outcome: 'refused', reason });
  }
}

/**
 * The sign-in window's round, decided once both `booted` resolved and the first vetting came, or null for a round it
 * refused. A site's refusal is counted with its reason, and its sign-in or transaction counts its own outcome. Rejects
 * when `booted` rejects.
 */
export async function answerSignIn<Booted>({
  responder,
  request,
  enabled,
  booted,
}: AnswerSignInParams<Booted>): Promise<SignInRound<Booted> | null> {
  const [bootedValue, vetted] = await Promise.all([booted, waitForFirstVetting(responder)]);
  const answerable = dispatchVetted({ responder, request, enabled }, vetted);
  if (answerable === null) {
    return null;
  }
  const { round, origin } = answerable;
  switch (round.kind) {
    case 'first':
      // dot.li's own flow runs only for a sign-in request.
      if (round.request.route !== 'auth') {
        refuseRound({ responder, party: 'first', reason: 'bad_request', route: request.route });
        return null;
      }
      return { party: 'first', intent: round.request.intent, booted: bootedValue };
    case 'third':
      return { party: 'third', origin, request: round.request, booted: bootedValue };
    case 'third-sign':
      return { party: 'third-sign', origin, request: round.request, booted: bootedValue };
  }
}

/**
 * Answers the sign-out window's round: a round the first vetting's dispatch refuses gets its refusal at once and never
 * the read, and an answerable one gets the empty result once `read` settled, whichever comes last. The page need not
 * wait for a window that will never read.
 */
export function answerSignOut({ responder, request, enabled, read }: AnswerSignOutParams): SignOutAnswer {
  // Handled at once, as the sign-out may fail before any hello.
  const settledRead = read.then(
    () => undefined,
    () => undefined,
  );
  const answerable = waitForFirstVetting(responder).then(vetted =>
    dispatchVetted({ responder, request, enabled }, vetted),
  );
  return {
    // A refusal that failed to post leaves the round no page's of dot.li.
    firstParty: answerable.then(
      answered => answered?.round.kind === 'first',
      () => false,
    ),
    answered: answerable.then(async answered => {
      if (answered === null) {
        return;
      }
      await settledRead;
      responder.send(SIGNED_OUT_RESULT);
    }),
  };
}

/** The site route whose metric a site's refusal on `route` counts on. */
function getRefusedSiteRoute(route: SessionRoute): SiteRoute {
  switch (route) {
    case 'sign':
      return 'sign';
    case 'auth':
    case 'signout':
    case 'manage':
      return 'auth';
  }
}

/** Resolves with the responder's first vetting, or null once it can have none: no opener, or one it refused. */
async function waitForFirstVetting(responder: Pick<Responder<unknown>, 'state'>): Promise<Vetted | null> {
  const settled = await waitForStatus(responder.state, state => getVetting(state) !== undefined);
  return getVetting(settled) ?? null;
}

/** The vetting `state` shows, null when the window can have none, or undefined while it may still come. */
function getVetting(state: ResponderState): Vetted | null | undefined {
  switch (state.kind) {
    case 'vetted':
      return { origin: state.origin, party: state.party };
    case 'no-opener':
    case 'refused':
      return null;
    case 'connecting':
    case 'answered':
      return undefined;
  }
}

/**
 * The round the first vetting's dispatch makes, or null when there is no vetting, as for an opener the responder
 * already turned away, or when the dispatch refuses the round, which this refuses.
 */
function dispatchVetted(
  { responder, request, enabled }: DispatchVettedParams,
  vetted: Vetted | null,
): Answerable | null {
  if (vetted === null) {
    return null;
  }
  const round = dispatchRound({ request, party: vetted.party, enabled });
  if (round.kind === 'refuse') {
    refuseRound({ responder, party: vetted.party, reason: round.reason, route: request.route });
    return null;
  }
  return { round, origin: vetted.origin };
}
