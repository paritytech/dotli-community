// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The session window's side of a round, for a sign-in and a sign-out window alike. The window learns who opened it
// only when the opener speaks, and the browser vouches for the speaker, so a hello counts only from this window's
// opener, for the round and protocol version of the window's own request, on an origin the judge gives a party. The
// first origin vetted is the one the window answers, alone, for the rest of the round, and the only one whose payload
// it takes.

import { m, spans as S } from '@dotli/metrics';
import { createDeferred, createStoreStatus, createSyncStore, listen, log } from '@dotli/shared';
import type { OpenerParty, Party, SessionOpenerVerdict } from './openerRule.js';
import { listenToMessages, type MessageEventLike, type WindowHandle } from './listenToMessages.js';
import {
  createCancelledMessage,
  createRefusedMessage,
  createResultMessage,
  parseHello,
  parsePayload,
  PROTOCOL_VERSION,
  READY,
  type PageMessage,
  type PayloadMessage,
  type RefusalReason,
} from './sessionMessages.js';

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

/** The window's side of a round, which answers its opener at most once. */
export type Responder<Result> = {
  /** Where the window stands with its opener now. */
  state(): ResponderState;
  /** Calls `listener` with each new state until the returned unsubscribe. */
  subscribe(listener: (state: ResponderState) => void): () => void;
  /**
   * Sends the result to the vetted opener, once, with the site's token when one is given. A window waiting to be vetted
   * again sends it on that vetting. Without an opener there is nobody to send it to.
   */
  send(result: Result, options?: SendParams): void;
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
  /**
   * Stops hearing the opener's messages and the page's return from the back-forward cache, is safe to call twice and
   * never throws, and leaves a round still open hearing nothing more, while a payload already taken stays kept.
   */
  dispose(): void;
};

type SendParams = {
  /** The site's token, which the result carries when given. */
  siteToken?: string | undefined;
};

type Params = {
  /** `window.opener`, null when no page opened this window or the link to it was cut. */
  opener: WindowHandle | null;
  /** The party of a hello's origin, or why it has none. */
  judge: (origin: string) => OpenerParty;
  /** The round of the window's own request. */
  round: string;
  /** Hears the page's `message` events until the returned stop. */
  listen: (handler: (event: MessageEventLike) => void) => () => void;
  /** Hears the page coming back from the back-forward cache until the returned stop. */
  onPageRestore: (listener: () => void) => () => void;
};

type AnswerParams<Result> = {
  origin: string;
  result: Result;
  siteToken: string | undefined;
};

/** The window's side of `round`, which says ready to its opener at once when it has one. */
export function createResponder<Result>({ opener, judge, round, listen, onPageRestore }: Params): Responder<Result> {
  const store = createSyncStore<ResponderState>({
    name: 'sessionResponder',
    initial: {
      kind: opener === null ? 'no-opener' : 'connecting',
    },
  });
  // The first origin vetted, which the window answers alone, since the opener tab may move to another site while the
  // window sits in the back-forward cache.
  let pinned: { origin: string; party: Party } | null = null;
  // A result finished while the window waits to be vetted, which goes out with that vetting. One finished before the
  // first vetting was made with no party known, so only a first party gets it. This is defense in depth, as a caller
  // may wait for the vetting before it sends, and keeps a site from a result made before its party was known.
  let held: { result: Result; siteToken: string | undefined; beforePin: boolean } | null = null;
  // A promise settles once, so the first payload taken is the one kept.
  const call = createDeferred<string>();

  function post(message: PageMessage, target: string): void {
    opener?.postMessage(message, target);
  }

  // Ready names only the versions the window speaks and goes to any origin, since the window cannot know its opener's
  // before the hello.
  function sayReady(): void {
    post(READY, '*');
  }

  function answer({ origin, result, siteToken }: AnswerParams<Result>): void {
    held = null;
    post(createResultMessage({ round, result, siteToken }), origin);
    store.set({ kind: 'answered' });
  }

  function refuseOpener(origin: string, verdict: Exclude<SessionOpenerVerdict, 'allowed'>): void {
    store.set({ kind: 'refused' });
    // The round, which the opener already knows, and a fixed reason, so a refused page learns nothing about the main
    // store.
    post(createRefusedMessage(round, 'origin_not_allowed'), origin);
    // The origin is the opener's to choose, so it goes to the log line and only the verdict to the count.
    log.warn(`[dot.li] Session window refused its opener (${verdict}): ${origin}`);
    m.count(S.SESSION_WINDOW_REFUSED, { outcome: 'refused', reason: verdict });
  }

  function vet({ origin, party }: { origin: string; party: Party }): void {
    log.event('session window vetted its opener', { flow: 'wallet' });
    if (held !== null && (!held.beforePin || party === 'first')) {
      answer({ origin, result: held.result, siteToken: held.siteToken });
      return;
    }
    store.set({ kind: 'vetted', origin, party });
  }

  // A payload counts in any state once the window was first vetted, since a restored window waiting to be vetted again
  // still answers the origin it pinned.
  function takePayload(origin: string, payload: PayloadMessage): void {
    if (pinned?.origin === origin && payload.round === round) {
      call.resolve(payload.call);
    }
  }

  function handleMessage(event: MessageEventLike): void {
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
  }

  // The opener keeps a round open while the window it opened is, so a restored window says ready again and is vetted
  // anew with its request's round, which the opener still holds.
  function restore(): void {
    const kind = store.get().kind;
    if (kind !== 'vetted' && kind !== 'connecting') {
      return;
    }
    log.event('session window restored, saying ready again', { flow: 'wallet' });
    store.set({ kind: 'connecting' });
    sayReady();
  }

  const stops: (() => void)[] = [];
  if (opener !== null) {
    stops.push(listen(handleMessage), onPageRestore(restore));
    sayReady();
  }

  function dispose(): void {
    for (const stop of stops.splice(0)) {
      stop();
    }
  }

  const status = createStoreStatus(store);

  return {
    state: status.get,
    subscribe: status.subscribe,
    send(result, { siteToken } = {}) {
      const state = store.get();
      switch (state.kind) {
        case 'vetted':
          answer({ origin: state.origin, result, siteToken });
          return;
        case 'connecting':
          held = { result, siteToken, beforePin: pinned === null };
          return;
        case 'refused':
        case 'no-opener':
        case 'answered':
          return;
      }
    },
    // Each posts before the state changes, so a listener that closes the window on the round's end closes it after.
    refuse(reason) {
      if (pinned === null || hasRoundEnded(store.get())) {
        return;
      }
      held = null;
      post(createRefusedMessage(round, reason), pinned.origin);
      store.set({ kind: 'refused' });
    },
    cancel() {
      if (pinned === null || hasRoundEnded(store.get())) {
        return;
      }
      held = null;
      post(createCancelledMessage(round), pinned.origin);
      store.set({ kind: 'answered' });
    },
    payload: () => call.promise,
    dispose,
  };
}

/**
 * The responder for `round` over the window's own page, which posts ready to its opener at once. `judge` names the
 * party of each origin that says hello.
 */
export function startPageResponder<Result>(round: string, judge: (origin: string) => OpenerParty): Responder<Result> {
  return createResponder<Result>({
    // Typed `any` by the DOM library.
    opener: window.opener as WindowHandle | null,
    judge,
    round,
    listen: listenToMessages,
    onPageRestore: listenToPageRestore,
  });
}

function hasRoundEnded(state: ResponderState): boolean {
  switch (state.kind) {
    case 'refused':
    case 'answered':
      return true;
    case 'connecting':
    case 'vetted':
    case 'no-opener':
      return false;
  }
}

function listenToPageRestore(listener: () => void): () => void {
  return listen({
    target: window,
    type: 'pageshow',
    handler: event => {
      if (event.persisted) {
        listener();
      }
    },
  });
}
