// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The session window's side of a round, for a sign-in and a sign-out window alike. The window learns who opened it
// only when the opener speaks, and the browser vouches for the speaker, so a hello counts only from this window's
// opener, for the round and protocol version of the window's own request, on an origin the judge gives a party. The
// first origin vetted is the one the window answers, alone, for the rest of the round, and the only one whose payload
// it takes.

import { m, spans as S } from '@dotli/metrics';
import { createSyncStore, listen, log } from '@dotli/shared';
import type { OpenerParty, SessionOpenerVerdict } from './opener-rule.js';
import { listenToMessages, type MessageEventLike, type WindowHandle } from './messages.js';
import {
  parseHello,
  parsePayload,
  PROTOCOL_VERSION,
  READY,
  type CancelledMessage,
  type PageMessage,
  type PayloadMessage,
  type RefusalReason,
  type RefusedMessage,
  type ResultMessage,
} from './session-protocol.js';

type Party = 'first' | 'third';

/**
 * Where the window stands with its opener. `connecting` waits for a vetted hello, as at the start and once restored
 * from the back-forward cache. `answered` sent the result or the cancel, the round's last word.
 */
export type ResponderState =
  | { kind: 'connecting' }
  | { kind: 'vetted'; origin: string; party: Party }
  | { kind: 'refused' }
  | { kind: 'no-opener' }
  | { kind: 'answered' };

export type Responder<R> = {
  state(): ResponderState;
  subscribe(listener: (state: ResponderState) => void): () => void;
  /**
   * Sends the result to the vetted opener, once, with the site's token when one is given. A window waiting to be vetted
   * again sends it on that vetting. Without an opener there is nobody to send it to.
   */
  send(result: R, siteToken?: string): void;
  /** Refuses the round to the first vetted origin. Before that vetting, or once the round ended, it does nothing. */
  refuse(reason: RefusalReason): void;
  /**
   * Tells the first vetted origin the user left the round. Before that vetting, or once the round ended, it does
   * nothing.
   */
  cancel(): void;
  /**
   * The call of the first payload the vetted opener sent for this round once it was first vetted, kept from when it
   * arrived. It never settles when none comes.
   */
  payload(): Promise<string>;
};

/** The round's result, with the token the site keeps when it gets one. */
export function resultMessage<R>(round: string, result: R, siteToken: string | undefined): ResultMessage<R> {
  return { type: 'dotli:s:result', round, result, ...(siteToken === undefined ? {} : { site_token: siteToken }) };
}

/** The round refused with `reason`. */
export function refusedMessage(round: string, reason: RefusalReason): RefusedMessage {
  return { type: 'dotli:s:refused', round, reason };
}

/** The user left the round without an answer. */
export function cancelledMessage(round: string): CancelledMessage {
  return { type: 'dotli:s:cancelled', round };
}

export type ResponderDeps = {
  /** `window.opener`, null when no page opened this window or the link to it was cut. */
  opener: WindowHandle | null;
  /** The party of a hello's origin, or why it has none. */
  judge: (origin: string) => OpenerParty;
  listen: (handler: (event: MessageEventLike) => void) => () => void;
  /** The page coming back from the back-forward cache. */
  onPageRestore: (listener: () => void) => () => void;
};

export function createResponder<R>({
  opener,
  judge,
  round,
  listen,
  onPageRestore,
}: ResponderDeps & { round: string }): Responder<R> {
  const store = createSyncStore<ResponderState>('sessionResponder', {
    kind: opener === null ? 'no-opener' : 'connecting',
  });
  // The first origin vetted, which the window answers alone, since the opener tab may move to another site while the
  // window sits in the back-forward cache.
  let pinned: { origin: string; party: Party } | null = null;
  // A result finished while the window waits to be vetted, which goes out with that vetting. One finished before the
  // first vetting was made with no party known, so only a first party gets it. This is defense in depth, as a caller
  // may wait for the vetting before it sends, and keeps a site from a result made before its party was known.
  let held: { result: R; siteToken: string | undefined; beforePin: boolean } | null = null;
  // A promise settles once, so the first payload taken is the one kept.
  let takeCall: (call: string) => void = () => undefined;
  const call = new Promise<string>(resolve => {
    takeCall = resolve;
  });

  const ended = (): boolean => {
    const kind = store.get().kind;
    return kind === 'refused' || kind === 'answered';
  };

  const post = (message: PageMessage, target: string): void => {
    opener?.postMessage(message, target);
  };

  // Ready names only the versions the window speaks and goes to any origin, since the window cannot know its opener's
  // before the hello.
  const sayReady = (): void => {
    post(READY, '*');
  };

  const answer = (origin: string, result: R, siteToken: string | undefined): void => {
    held = null;
    post(resultMessage(round, result, siteToken), origin);
    store.set({ kind: 'answered' });
  };

  const refuseOpener = (origin: string, verdict: Exclude<SessionOpenerVerdict, 'allowed'>): void => {
    store.set({ kind: 'refused' });
    // The round, which the opener already knows, and a fixed reason, so a refused page learns nothing about the main
    // store.
    post(refusedMessage(round, 'origin_not_allowed'), origin);
    // The origin is the opener's to choose, so it goes to the log line and only the verdict to the count.
    log.warn(`[dot.li] Session window refused its opener (${verdict}): ${origin}`);
    m.count(S.SESSION_WINDOW_REFUSED, { outcome: 'refused', reason: verdict });
  };

  const vet = ({ origin, party }: { origin: string; party: Party }): void => {
    log.event('session window vetted its opener', { flow: 'wallet' });
    if (held !== null && (!held.beforePin || party === 'first')) {
      answer(origin, held.result, held.siteToken);
      return;
    }
    store.set({ kind: 'vetted', origin, party });
  };

  // A payload counts in any state once the window was first vetted, since a restored window waiting to be vetted again
  // still answers the origin it pinned.
  const takePayload = (origin: string, payload: PayloadMessage): void => {
    if (pinned?.origin === origin && payload.round === round) {
      takeCall(payload.call);
    }
  };

  const onMessage = (event: MessageEventLike): void => {
    if (event.source !== opener) {
      return;
    }
    const payload = parsePayload(event.data);
    if (payload !== null) {
      takePayload(event.origin, payload);
      return;
    }
    // One opener, one answer: a hello after the window decided changes nothing.
    if (store.get().kind !== 'connecting') {
      return;
    }
    const hello = parseHello(event.data);
    if (hello?.v !== PROTOCOL_VERSION || hello.round !== round) {
      return;
    }
    if (pinned !== null) {
      // A restored window is vetted again only by the origin it answers. Another one is no refusal, since the round
      // is still that origin's.
      if (event.origin === pinned.origin) {
        vet(pinned);
      }
      return;
    }
    const judged = judge(event.origin);
    if (judged.party === null) {
      refuseOpener(event.origin, judged.verdict);
      return;
    }
    pinned = { origin: event.origin, party: judged.party };
    vet(pinned);
  };

  // The opener keeps a round open while the window it opened is, so a restored window says ready again and is vetted
  // anew with its request's round, which the opener still holds.
  const restore = (): void => {
    const kind = store.get().kind;
    if (kind !== 'vetted' && kind !== 'connecting') {
      return;
    }
    log.event('session window restored, saying ready again', { flow: 'wallet' });
    store.set({ kind: 'connecting' });
    sayReady();
  };

  if (opener !== null) {
    listen(onMessage);
    onPageRestore(restore);
    sayReady();
  }

  return {
    state: store.get,
    subscribe: listener =>
      store.subscribe(() => {
        listener(store.get());
      }),
    send(result, siteToken) {
      const state = store.get();
      if (state.kind === 'vetted') {
        answer(state.origin, result, siteToken);
      } else if (state.kind === 'connecting') {
        held = { result, siteToken, beforePin: pinned === null };
      }
    },
    // Each posts before the state changes, so a listener that closes the window on the round's end closes it after.
    refuse(reason) {
      if (pinned === null || ended()) {
        return;
      }
      held = null;
      post(refusedMessage(round, reason), pinned.origin);
      store.set({ kind: 'refused' });
    },
    cancel() {
      if (pinned === null || ended()) {
        return;
      }
      held = null;
      post(cancelledMessage(round), pinned.origin);
      store.set({ kind: 'answered' });
    },
    payload: () => call,
  };
}

function listenToPageRestore(listener: () => void): () => void {
  return listen(window, 'pageshow', event => {
    if (event.persisted) {
      listener();
    }
  });
}

/**
 * The responder for `round` over the window's own page, which posts ready to its opener at once. `judge` names the
 * party of each origin that says hello.
 */
export function startPageResponder<R>(round: string, judge: (origin: string) => OpenerParty): Responder<R> {
  return createResponder<R>({
    // Typed `any` by the DOM library.
    opener: window.opener as WindowHandle | null,
    judge,
    round,
    listen: listenToMessages,
    onPageRestore: listenToPageRestore,
  });
}
