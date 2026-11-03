// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// When a session window answers its round, and with what. The first vetting names the round's party and origin, which
// the dispatch turns into a round: a refused one gets its refusal alone, and an answerable one waits for what the
// window has to give, a sign-in window's boot or a sign-out window's read.

import type { Network } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { log, waitForStatus } from '@dotli/shared';
import type { SiteRequest } from '../siteSignIn/parseSiteRequest.js';
import type { SiteSignRequest } from '../siteSignIn/parseSiteSignRequest.js';
import type { SignInIntent } from './parseWindowRequest.js';
import type { Responder, ResponderState } from './createResponder.js';
import { dispatchRound, type Round } from './dispatchRound.js';
import type { Party } from './openerRule.js';
import type { SessionRequest } from './readSessionRequest.js';
import type { RefusalReason } from './sessionMessages.js';
import type { SessionRoute } from './sessionRoute.js';

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

type AnswerSignInParams<Booted> = {
  responder: Pick<Responder<unknown>, 'state' | 'subscribe' | 'refuse'>;
  request: SessionRequest;
  /** The networks this deployment runs. */
  enabled: readonly Network[];
  /** What the window's boot gives. Rejects when the boot failed. */
  booted: Promise<Booted>;
};

type AnswerSignOutParams = Omit<AnswerSignInParams<never>, 'responder' | 'booted'> & {
  responder: Pick<Responder<typeof SIGNED_OUT_RESULT>, 'state' | 'subscribe' | 'refuse' | 'send'>;
  /**
   * Settles once the window read what it ends. Rejects for a sign-out that failed before it read, such as one whose
   * boot failed, which reports its own failure.
   */
  read: Promise<unknown>;
};

type GetSignInRoundParams<Booted> = {
  round: Round;
  /** The vetted origin, which a site's round takes. */
  origin: string;
  booted: Booted;
};

/** What `/s/signout` sends as its result, since it ends a session and has none to hand over. */
export const SIGNED_OUT_RESULT: Readonly<Record<string, never>> = {};

/**
 * Refuses the round with `reason`, leaves a breadcrumb, and counts a site's refusal as the outcome of its round on
 * `route`: a transaction on the sign route, else a sign-in.
 */
export function refuseRound({ responder, party, reason, route }: RefuseRoundParams): void {
  responder.refuse(reason);
  log.event('session window refused its round', { flow: 'wallet', party, reason });
  if (party === 'third') {
    m.count(route === 'sign' ? S.SITE_TRANSACTION : S.SITE_SIGN_IN, { outcome: 'refused', reason });
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
  // The responder already turned away an opener it refused.
  if (vetted === null) {
    return null;
  }
  const round = dispatchRound({ request, party: vetted.party, enabled });
  const answer = getSignInRound({ round, origin: vetted.origin, booted: bootedValue });
  if (typeof answer === 'string') {
    refuseRound({ responder, party: vetted.party, reason: answer, route: request.route });
    return null;
  }
  return answer;
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
  const round = waitForFirstVetting(responder).then(vetted => {
    if (vetted === null) {
      return null;
    }
    const dispatched = dispatchRound({ request, party: vetted.party, enabled });
    if (dispatched.kind === 'refuse') {
      refuseRound({ responder, party: vetted.party, reason: dispatched.reason, route: request.route });
      return null;
    }
    return dispatched;
  });
  return {
    // A refusal that failed to post leaves the round no page's of dot.li.
    firstParty: round.then(
      dispatched => dispatched?.kind === 'first',
      () => false,
    ),
    answered: round.then(async dispatched => {
      if (dispatched === null) {
        return;
      }
      await settledRead;
      responder.send(SIGNED_OUT_RESULT);
    }),
  };
}

/** Resolves with the responder's first vetting, or null once it can have none: no opener, or one it refused. */
async function waitForFirstVetting(responder: Pick<Responder<unknown>, 'state' | 'subscribe'>): Promise<Vetted | null> {
  let vetting: Vetted | null | undefined;
  await waitForStatus({ get: responder.state, listen: responder.subscribe }, state => {
    vetting = getVetting(state);
    return vetting !== undefined;
  });
  return vetting ?? null;
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
 * The round the sign-in window runs, or the reason it refuses one it runs no flow for: the dispatch's reason, or a bad
 * request for a first-party request of another route.
 */
function getSignInRound<Booted>({
  round,
  origin,
  booted,
}: GetSignInRoundParams<Booted>): SignInRound<Booted> | RefusalReason {
  switch (round.kind) {
    case 'first':
      if (round.request.route !== 'auth') {
        return 'bad_request';
      }
      return { party: 'first', intent: round.request.intent, booted };
    case 'third':
      return { party: 'third', origin, request: round.request, booted };
    case 'third-sign':
      return { party: 'third-sign', origin, request: round.request, booted };
    case 'refuse':
      return round.reason;
  }
}
