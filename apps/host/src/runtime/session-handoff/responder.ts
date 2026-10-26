// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in window's side of a round. The window learns who opened it only when the opener speaks, and the browser
// vouches for the speaker, so a hello counts only from this window's opener, on an origin the opener rule allows. The
// window answers that origin alone, with the round its hello named.

import { m, spans as S } from '@dotli/metrics';
import { createSyncStore, listen, log } from '@dotli/shared';
import { sessionOpenerVerdict, type SessionOpenerVerdict } from './opener-rule.js';
import {
  listenToMessages,
  parseOpenerMessage,
  type MessageEventLike,
  type SessionResult,
  type SignInIntent,
  type WindowHandle,
  type WindowMessage,
} from './messages.js';

/**
 * Where the window stands with its opener. `connecting` waits for a vetted hello, as at the start and once restored
 * from the back-forward cache. `answered` sent the result, the round's last word.
 */
export type ResponderState =
  | { kind: 'connecting' }
  | { kind: 'vetted'; origin: string; round: string; intent: SignInIntent }
  | { kind: 'refused' }
  | { kind: 'no-opener' }
  | { kind: 'answered' };

export interface Responder {
  state(): ResponderState;
  subscribe(listener: (state: ResponderState) => void): () => void;
  /**
   * Sends the result to the vetted opener, once. A window waiting to be vetted again sends it on that vetting. Without
   * an opener there is nobody to send it to.
   */
  send(result: SessionResult): void;
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

/** Ready carries nothing and goes to any origin, since the window cannot know its opener's before the hello. */
const READY: WindowMessage = { type: 'dotli:session:ready' };

export function createResponder({ opener, self, listen, onPageRestore }: ResponderDeps): Responder {
  const store = createSyncStore<ResponderState>('sessionResponder', {
    kind: opener === null ? 'no-opener' : 'connecting',
  });
  // A result finished while the window waits to be vetted again, which goes out with that vetting.
  let held: SessionResult | null = null;

  const post = (message: WindowMessage, target: string): void => {
    opener?.postMessage(message, target);
  };

  const answer = (origin: string, round: string, result: SessionResult): void => {
    post({ type: 'dotli:session:result', round, result }, origin);
    store.set({ kind: 'answered' });
  };

  const refuse = (origin: string, round: string, reason: Exclude<SessionOpenerVerdict, 'allowed'>): void => {
    store.set({ kind: 'refused' });
    // Only the round, which the opener already knows, so a refused page learns nothing about the main store.
    post({ type: 'dotli:session:refused', round }, '*');
    // The origin is the opener's to choose, so it goes to the log line and only the verdict to the count.
    log.warn(`[dot.li] Sign-in window refused its opener (${reason}): ${origin}`);
    m.count(S.SESSION_WINDOW_REFUSED, { outcome: 'refused', reason });
  };

  const onMessage = (event: MessageEventLike): void => {
    // One opener, one answer: a hello after the window decided changes nothing.
    if (event.source !== opener || store.get().kind !== 'connecting') {
      return;
    }
    const hello = parseOpenerMessage(event.data);
    if (hello === null) {
      return;
    }
    const verdict = sessionOpenerVerdict(event.origin, self);
    if (verdict !== 'allowed') {
      refuse(event.origin, hello.round, verdict);
      return;
    }
    log.event('sign-in window vetted its opener', { flow: 'wallet', intent: hello.intent });
    if (held !== null) {
      const result = held;
      held = null;
      answer(event.origin, hello.round, result);
      return;
    }
    store.set({ kind: 'vetted', origin: event.origin, round: hello.round, intent: hello.intent });
  };

  // The opener keeps a round open while the window it opened is, so a restored window says ready again and is vetted
  // anew with the round the opener still holds.
  const restore = (): void => {
    const kind = store.get().kind;
    if (kind !== 'vetted' && kind !== 'connecting') {
      return;
    }
    log.event('sign-in window restored, saying ready again', { flow: 'wallet' });
    store.set({ kind: 'connecting' });
    post(READY, '*');
  };

  if (opener !== null) {
    listen(onMessage);
    onPageRestore(restore);
    post(READY, '*');
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
        answer(state.origin, state.round, result);
      } else if (state.kind === 'connecting') {
        held = result;
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

/** The window's responder over its own page, which posts ready to its opener at once. */
export function startPageResponder(): Responder {
  return createResponder({
    // Typed `any` by the DOM library.
    opener: window.opener as WindowHandle | null,
    self: window.location.origin,
    listen: listenToMessages,
    onPageRestore: listenToPageRestore,
  });
}
