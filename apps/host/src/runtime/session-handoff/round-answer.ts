// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// When a session window answers its round, and with what. The first vetting names the round's party and origin, which
// the dispatch turns into a round: a refused one gets its refusal alone, and an answerable one waits for what the
// window has to give, a sign-in window's boot or a sign-out window's read.

import type { Network } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { SiteRequest } from '../site-sign-in/site-request.js';
import type { SiteSignRequest } from '../site-sign-in/site-sign-request.js';
import { SIGNED_OUT_RESULT, type SignInIntent } from './messages.js';
import type { Responder, ResponderState } from './responder.js';
import { dispatchRound, type Round } from './round-dispatch.js';
import type { RefusalReason, SessionRequest, SessionRoute } from './session-protocol.js';

export type RoundAnswerDeps<R> = {
  responder: Pick<Responder<R>, 'state' | 'subscribe' | 'refuse'>;
  request: SessionRequest;
  /** The networks this deployment runs. */
  enabled: readonly Network[];
};

/** The origin and party of the responder's first vetting, which stay the round's. */
type Vetted = {
  origin: string;
  party: 'first' | 'third';
};

/** Resolves with the responder's first vetting, or null once it can have none: no opener, or one it refused. */
function firstVetting(responder: Pick<Responder<unknown>, 'state' | 'subscribe'>): Promise<Vetted | null> {
  return new Promise(resolve => {
    const settled = (state: ResponderState): boolean => {
      if (state.kind === 'vetted') {
        resolve({ origin: state.origin, party: state.party });
        return true;
      }
      if (state.kind === 'no-opener' || state.kind === 'refused') {
        resolve(null);
        return true;
      }
      return false;
    };
    if (settled(responder.state())) {
      return;
    }
    const stop = responder.subscribe(state => {
      if (settled(state)) {
        stop();
      }
    });
  });
}

/**
 * What the sign-in window runs for its round: dot.li's own flow for the request's intent, or a site's sign-in or
 * transaction for the vetted origin, which the browser vouched for, never one the request names. Each comes with what
 * the boot gave.
 */
export type SignInRound<B> =
  | { party: 'first'; intent: SignInIntent; booted: B }
  | { party: 'third'; origin: string; request: SiteRequest; booted: B }
  | { party: 'third-sign'; origin: string; request: SiteSignRequest; booted: B };

/**
 * Why the sign-in window refuses a round it runs no flow for: the dispatch's reason, or a bad request for a first-party
 * request of another route.
 */
function signInRefusal(round: Exclude<Round, { kind: 'third' | 'third-sign' }>): RefusalReason {
  return round.kind === 'refuse' ? round.reason : 'bad_request';
}

/**
 * Refuses the round with `reason`, leaves a breadcrumb, and counts a site's refusal as the outcome of its round on
 * `route`: a transaction on the sign route, else a sign-in.
 */
export function refuseRound(
  responder: Pick<Responder<unknown>, 'refuse'>,
  party: Vetted['party'],
  reason: RefusalReason,
  route: SessionRoute,
): void {
  responder.refuse(reason);
  log.event('session window refused its round', { flow: 'wallet', party, reason });
  if (party === 'third') {
    m.count(route === 'sign' ? S.SITE_TRANSACTION : S.SITE_SIGN_IN, { outcome: 'refused', reason });
  }
}

/**
 * The sign-in window's round, decided once both `booted` resolved and the first vetting came, or null for a round it
 * refused. A site's refusal is counted with its reason, and its sign-in or transaction counts its own outcome.
 */
export async function answerSignIn<B>(
  deps: RoundAnswerDeps<unknown> & { booted: Promise<B> },
): Promise<SignInRound<B> | null> {
  const { responder, request, enabled } = deps;
  const [booted, vetted] = await Promise.all([deps.booted, firstVetting(responder)]);
  // The responder already turned away an opener it refused.
  if (vetted === null) {
    return null;
  }
  const round = dispatchRound(request, vetted.party, enabled);
  if (round.kind === 'first' && round.request.route === 'auth') {
    return { party: 'first', intent: round.request.intent, booted };
  }
  if (round.kind === 'third') {
    return { party: 'third', origin: vetted.origin, request: round.request, booted };
  }
  if (round.kind === 'third-sign') {
    return { party: 'third-sign', origin: vetted.origin, request: round.request, booted };
  }
  refuseRound(responder, vetted.party, signInRefusal(round), request.route);
  return null;
}

/** How the sign-out window answers its round. */
export type SignOutAnswer = {
  /**
   * True once the first vetting found dot.li's own page with a round the window answers, and false once it found a
   * site or a round it refuses, or the window can have no vetting. Never rejects.
   */
  firstParty: Promise<boolean>;
  /** Settles once the round got its answer, or has nobody to answer. */
  answered: Promise<void>;
};

/**
 * Answers the sign-out window's round: a round the first vetting's dispatch refuses gets its refusal at once and never
 * the read, and an answerable one gets the empty result once `read` settled, whichever comes last. `read` rejects for
 * a sign-out that failed before it read, such as one whose boot failed, which reports its own failure, and the page
 * need not wait for a window that will never read.
 */
export function answerSignOut(
  deps: RoundAnswerDeps<typeof SIGNED_OUT_RESULT> & {
    responder: Pick<Responder<typeof SIGNED_OUT_RESULT>, 'state' | 'send'>;
    read: Promise<unknown>;
  },
): SignOutAnswer {
  const { responder, request, enabled } = deps;
  // Handled at once, as the sign-out may fail before any hello.
  const read = deps.read.then(
    () => undefined,
    () => undefined,
  );
  const round = firstVetting(responder).then(vetted => {
    if (vetted === null) {
      return null;
    }
    const dispatched = dispatchRound(request, vetted.party, enabled);
    if (dispatched.kind === 'refuse') {
      refuseRound(responder, vetted.party, dispatched.reason, request.route);
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
      await read;
      responder.send(SIGNED_OUT_RESULT);
    }),
  };
}
