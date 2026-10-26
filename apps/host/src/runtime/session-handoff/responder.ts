// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The session window's side of a round, for a sign-in and a sign-out window alike. The window learns who opened it
// only when the opener speaks, and the browser vouches for the speaker, so a hello counts only from this window's
// opener, for the round and protocol version of the window's own request, on an origin the opener rule allows. The
// window answers that origin alone.

import { m, spans as S } from '@dotli/metrics';
import { createSyncStore, listen, log } from '@dotli/shared';
import { sessionOpenerVerdict, type SessionOpenerVerdict } from './opener-rule.js';
import { listenToMessages, type MessageEventLike, type WindowHandle } from './messages.js';
import { parseHello, PROTOCOL_VERSION, READY, type PageMessage } from './session-protocol.js';

/**
 * Where the window stands with its opener. `connecting` waits for a vetted hello, as at the start and once restored
 * from the back-forward cache. `answered` sent the result, the round's last word.
 */
export type ResponderState =
  | { kind: 'connecting' }
  | { kind: 'vetted'; origin: string }
  | { kind: 'refused' }
  | { kind: 'no-opener' }
  | { kind: 'answered' };

export interface Responder<R> {
  state(): ResponderState;
  subscribe(listener: (state: ResponderState) => void): () => void;
  /**
   * Sends the result to the vetted opener, once. A window waiting to be vetted again sends it on that vetting. Without
   * an opener there is nobody to send it to.
   */
  send(result: R): void;
}

export interface ResponderDeps {
  /** `window.opener`, null when no page opened this window or the link to it was cut. */
  opener: WindowHandle | null;
  /** This window's own origin, which the opener rule judges the opener against. */
  self: string;
  listen: (handler: (event: MessageEventLike) => void) => () => void;
  /** The page coming back from the back-forward cache. */
  onPageRestore: (listener: () => void) => () => void;
}

export function createResponder<R>({
  opener,
  self,
  round,
  listen,
  onPageRestore,
}: ResponderDeps & { round: string }): Responder<R> {
  const store = createSyncStore<ResponderState>('sessionResponder', {
    kind: opener === null ? 'no-opener' : 'connecting',
  });
  // A result finished while the window waits to be vetted again, which goes out with that vetting.
  let held: { result: R } | null = null;

  const post = (message: PageMessage, target: string): void => {
    opener?.postMessage(message, target);
  };

  // Ready names only the versions the window speaks and goes to any origin, since the window cannot know its opener's
  // before the hello.
  const sayReady = (): void => {
    post(READY, '*');
  };

  const answer = (origin: string, result: R): void => {
    post({ type: 'dotli:s:result', round, result }, origin);
    store.set({ kind: 'answered' });
  };

  const refuse = (origin: string, reason: Exclude<SessionOpenerVerdict, 'allowed'>): void => {
    store.set({ kind: 'refused' });
    // The round, which the opener already knows, and a fixed reason, so a refused page learns nothing about the main
    // store.
    post({ type: 'dotli:s:refused', round, reason: 'origin_not_allowed' }, origin);
    // The origin is the opener's to choose, so it goes to the log line and only the verdict to the count.
    log.warn(`[dot.li] Session window refused its opener (${reason}): ${origin}`);
    m.count(S.SESSION_WINDOW_REFUSED, { outcome: 'refused', reason });
  };

  const onMessage = (event: MessageEventLike): void => {
    // One opener, one answer: a hello after the window decided changes nothing.
    if (event.source !== opener || store.get().kind !== 'connecting') {
      return;
    }
    const hello = parseHello(event.data);
    if (hello?.v !== PROTOCOL_VERSION || hello.round !== round) {
      return;
    }
    const verdict = sessionOpenerVerdict(event.origin, self);
    if (verdict !== 'allowed') {
      refuse(event.origin, verdict);
      return;
    }
    log.event('session window vetted its opener', { flow: 'wallet' });
    if (held !== null) {
      const { result } = held;
      held = null;
      answer(event.origin, result);
      return;
    }
    store.set({ kind: 'vetted', origin: event.origin });
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
    send(result) {
      const state = store.get();
      if (state.kind === 'vetted') {
        answer(state.origin, result);
      } else if (state.kind === 'connecting') {
        held = { result };
      }
    },
  };
}

function listenToPageRestore(listener: () => void): () => void {
  return listen(window, 'pageshow', event => {
    if (event.persisted) {
      listener();
    }
  });
}

/** The responder for `round` over the window's own page, which posts ready to its opener at once. */
export function startPageResponder<R>(round: string): Responder<R> {
  return createResponder<R>({
    // Typed `any` by the DOM library.
    opener: window.opener as WindowHandle | null,
    self: window.location.origin,
    round,
    listen: listenToMessages,
    onPageRestore: listenToPageRestore,
  });
}
