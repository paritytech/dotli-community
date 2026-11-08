// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of the session window: it opens the window from the click at a request with a fresh round, answers
// each `ready` that speaks protocol version 1 with a hello for that round, and takes the window's result or refusal.
// The browser vouches for who speaks, so a message counts only from the window this page opened, on the root origin,
// and a result or refusal only for the round this page started. A sign-out opens the sign-out window and drops the
// signed-in flag in the click's turn, and answers that window's read to whoever asks.

import { getNetwork, type Network } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import { getProtocolOrigin } from '@dotli/protocol';
import { createDeferred, listenForPageReturn } from '@dotli/shared';
import { getSignInSurface, type PageRole } from '../pageRole.js';
import { sessionPresence } from '../session/createPagePresence.js';
import type { SessionPresence } from '../session/types.js';
import { createSignInWindowUrl, createSignOutWindowUrl } from './createSignInWindowUrl.js';
import type { SignInIntent } from './parseWindowRequest.js';
import { listenToMessages, type MessageEventLike, type WindowHandle } from './listenToMessages.js';
import { parseSessionResult, type SessionResult } from './parseSessionResult.js';
import { createHelloMessage, parsePageMessage, PROTOCOL_VERSION, type PageMessage } from './sessionMessages.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. A page's ask to sign in through the sign-in window. Tagged `outcome`: `opened` for a window it opened,
 * `blocked` for one the browser refused, and `busy` for an ask while the sign-out window was still open, which opened
 * no window. Tagged `reason`, the intent (`signin, phrase, resume`).
 */
const sessionWindowSigninMetric = defineCount<'blocked' | 'busy' | 'opened'>('session_window.signin');

/**
 * Count. How a sign-in round through the window ended. Tagged `outcome` and `reason`, what ended it: `signed_in` with
 * `window` for the window's result, or with `store` for a page that heard the window store the sign-in before its
 * result came, `refused` with `window`, `cancelled` with `closed` for a window found closed when the page came back,
 * `page` for the page's own Cancel or a window it opened in place of the round's, or `signed_out` for a sign-out that
 * ended it.
 */
const sessionWindowRoundMetric = defineCount<RoundTags['outcome']>('session_window.round');

/**
 * Count. A page's opening of the sign-out window. Tagged `outcome` (`opened, blocked`) and `reason`, whether the page
 * told the phone itself (`notified, unnotified`).
 */
const sessionWindowSignoutMetric = defineCount<'blocked' | 'opened'>('session_window.signout');

export type SignInOutcome =
  { kind: 'result'; result: SessionResult } | { kind: 'blocked' } | { kind: 'cancelled' } | { kind: 'refused' };

/** Why the page ended its own round: the user's Cancel, or the page became signed in by another route. */
export type PageCancelReason = 'page' | 'signed_in';

export type SessionHandoff = ReturnType<typeof createSessionHandoff>;

type Params = {
  /** Opens `url` in the window named `name`, or answers null when the browser blocked it. */
  open: (url: string, name: string) => WindowHandle | null;
  /** Hears the page's `message` events until the returned stop. */
  listen: (handler: (event: MessageEventLike) => void) => () => void;
  /** Focus and visibility events of the opener's own page. */
  onReturn: (listener: () => void) => () => void;
  /** A fresh round id. */
  randomId: () => string;
  /** The session windows' origin, the only one whose messages count. */
  windowOrigin: string;
  /** The network the page runs. */
  network: () => Network;
  /**
   * The signed-in flag, which a sign-out through the window drops. Never rejects, and reports its own failed writes.
   */
  presence: Pick<SessionPresence, 'clear'>;
};

/** Why a round ended without the window's word. A window opened in place of the round's ends it as `page`. */
type CancelReason = 'closed' | 'signed_out' | PageCancelReason;

/** What the page waits for on its open window: a sign-in round's outcome, or a sign-out window's read. */
type WindowWait = { readonly kind: 'signin' } | { readonly kind: 'signout'; readonly read: Promise<void> };

/**
 * The window's last word on a round: its result, not yet read as any one kind, or a refusal. A window that speaks no
 * version this page knows refuses it too, as it can never answer this page.
 */
type WindowWord = { readonly kind: 'result'; readonly result: unknown } | { readonly kind: 'refused' };

/** The one window the page has open. */
type OpenWindow = WindowWait & {
  readonly handle: WindowHandle;
  /** Settles what the page waits for on the window, as cancelled for a round. Only the open window ends, once. */
  end(reason: CancelReason): void;
};

/** How a round ended: with what the page made of the window's word, or with the reason it ended without one. */
type RoundEnd<Word> = { word: Word } | { reason: CancelReason };

/** How a sign-in round ended and what ended it, as its metric tags them. */
type RoundTags = {
  outcome: 'signed_in' | 'refused' | 'cancelled';
  reason: 'window' | 'store' | Exclude<CancelReason, 'signed_in'>;
};

type WatchWindowParams = {
  handle: WindowHandle;
  onMessage: (message: PageMessage) => void;
  onClosed: () => void;
};

type OpenRoundParams<Word> = {
  wait: WindowWait;
  /** The request URL for `round`. */
  urlFor: (round: string) => string;
  /** Takes how the round ended, once. */
  settle: (ended: RoundEnd<Word>) => void;
  /** What the page makes of the window's word, or null to leave the round open. */
  hear: (word: WindowWord) => Word | null;
};

// One name, so a second open reuses the window instead of stacking another.
const WINDOW_NAME = 'dotli-session';

let pageHandoff: SessionHandoff | undefined;

/** The page's side of the session window, with no window open. Building one opens and hears nothing. */
export function createSessionHandoff({ open, listen, onReturn, randomId, windowOrigin, network, presence }: Params) {
  let current: OpenWindow | null = null;

  /**
   * Hears `handle` until the returned stop: its messages from the root origin, and the page coming back to find it
   * closed, which is when a user who closed it returns. Only the handle says a window is gone, as a document that goes
   * may be a reload or a trip through the back-forward cache.
   */
  function watchWindow({ handle, onMessage, onClosed }: WatchWindowParams): () => void {
    const stopListening = listen(event => {
      if (event.source !== handle || event.origin !== windowOrigin) {
        return;
      }
      const message = parsePageMessage(event.data);
      if (message !== null) {
        onMessage(message);
      }
    });
    const stopReturn = onReturn(() => {
      if (handle.closed) {
        onClosed();
      }
    });
    return () => {
      stopListening();
      stopReturn();
    };
  }

  /**
   * Opens the window at the request `urlFor` builds for a fresh round, in place of the one open, which ends, and makes
   * it the open one until it settles, once: with what `hear` makes of the window's word for that round, or with the
   * reason it ended without one. Some pop-up blockers hand back a window that is already closed instead of none.
   */
  function openRound<Word>({ wait, urlFor, settle, hear }: OpenRoundParams<Word>): WindowHandle | null {
    current?.end('page');
    const round = randomId();
    const handle = open(urlFor(round), WINDOW_NAME);
    if (handle === null || handle.closed) {
      return null;
    }
    function finish(ended: RoundEnd<Word>): void {
      if (current !== opened) {
        return;
      }
      current = null;
      stop();
      settle(ended);
    }
    function take(windowWord: WindowWord): void {
      const word = hear(windowWord);
      if (word !== null) {
        finish({ word });
      }
    }
    function takeForRound(messageRound: string, windowWord: WindowWord): void {
      if (messageRound === round) {
        take(windowWord);
      }
    }
    function handleMessage(message: PageMessage): void {
      switch (message.type) {
        case 'dotli:s:ready':
          if (!message.versions.includes(PROTOCOL_VERSION)) {
            report.log.event('session window speaks no known protocol version');
            take({ kind: 'refused' });
            return;
          }
          // A reloaded or restored window says ready again and gets the same round.
          opened.handle.postMessage(createHelloMessage(round), windowOrigin);
          return;
        case 'dotli:s:result':
          takeForRound(message.round, { kind: 'result', result: message.result });
          return;
        case 'dotli:s:refused':
        case 'dotli:s:cancelled':
          takeForRound(message.round, { kind: 'refused' });
          return;
      }
    }
    const opened: OpenWindow = {
      ...wait,
      handle,
      end(reason) {
        finish({ reason });
      },
    };
    current = opened;
    const stop = watchWindow({
      handle,
      onMessage: handleMessage,
      onClosed() {
        finish({ reason: 'closed' });
      },
    });
    return handle;
  }

  return {
    /**
     * Opens the window synchronously, in place of a sign-in window this page still has open. While the sign-out window
     * is open, it brings that window to the front and answers cancelled, since the sign-out has yet to read or tell the
     * phone. Never rejects.
     */
    signIn(intent: SignInIntent): Promise<SignInOutcome> {
      if (current?.kind === 'signout') {
        current.handle.focus();
        report.log.event('sign-in window refused while signing out');
        sessionWindowSigninMetric.count({ outcome: 'busy', reason: intent });
        return Promise.resolve({ kind: 'cancelled' });
      }
      const outcome = createDeferred<SignInOutcome>();
      const handle = openRound<SignInOutcome>({
        wait: { kind: 'signin' },
        urlFor: round => createSignInWindowUrl({ intent, network: network(), round, origin: windowOrigin }),
        settle(ended) {
          const settled: SignInOutcome = 'word' in ended ? ended.word : { kind: 'cancelled' };
          report.log.event('sign-in window round ended', { outcome: settled.kind });
          sessionWindowRoundMetric.count(getRoundTags(ended));
          outcome.resolve(settled);
        },
        hear: hearSignIn,
      });
      if (handle === null) {
        report.log.event('sign-in window blocked');
        sessionWindowSigninMetric.count({ outcome: 'blocked', reason: intent });
        return Promise.resolve({ kind: 'blocked' });
      }
      sessionWindowSigninMetric.count({ outcome: 'opened', reason: intent });
      return outcome.promise;
    },
    /**
     * Opens the sign-out window and drops the signed-in flag, both before this returns. A call while the sign-out
     * window is open focuses it and leaves the flag alone.
     */
    signOut({ notified }: { notified: boolean }): void {
      if (current?.kind === 'signout') {
        current.handle.focus();
        return;
      }
      // A new window takes the shared window name, so a round left open would answer the new window's `ready`.
      current?.end('signed_out');
      const read = createDeferred<undefined>();
      // A blocked window never becomes `current`, so its read is the settled one `signOutRead` gives.
      const handle = openRound<true>({
        wait: { kind: 'signout', read: read.promise },
        urlFor: round => createSignOutWindowUrl({ notified, network: network(), round, origin: windowOrigin }),
        settle() {
          read.resolve(undefined);
        },
        // The sign-out window's result says it has read what it ends, and its refusal that it never will.
        hear: () => true,
      });
      sessionWindowSignoutMetric.count({
        outcome: handle === null ? 'blocked' : 'opened',
        reason: notified ? 'notified' : 'unnotified',
      });
      // In the window's own turn, so the flag is gone before its document loads and its restore rule finds the store
      // dead. A blocked window still signs the page out.
      void presence.clear();
    },
    /**
     * Settles once the open sign-out window has read what it ends, so the page may clear its own copy without taking
     * the session from under it, or once the page finds that window closed when it never said so. Settled at once when
     * no sign-out window is open, also when the browser blocked it. Never rejects.
     */
    signOutRead(): Promise<void> {
      return current?.kind === 'signout' ? current.read : Promise.resolve();
    },
    /** Brings the open round's window to the front, or ends the round when that window is gone. */
    focus(): void {
      if (current?.kind !== 'signin') {
        return;
      }
      // A user back on this page before any focus or visibility event of it, who closed the window, asks here.
      if (current.handle.closed) {
        current.end('closed');
      } else {
        current.handle.focus();
      }
    },
    /** Ends the open round and closes its window, counted under `reason`. */
    cancel(reason: PageCancelReason): void {
      const round = current;
      if (round?.kind !== 'signin') {
        return;
      }
      round.end(reason);
      round.handle.close();
    },
  };
}

/** The page's handoff when `role` signs in through the sign-in window, else null for a page that pairs in place. */
export function getPageSignInHandoff(role: PageRole): SessionHandoff | null {
  return getSignInSurface(role) === 'window' ? getPageSessionHandoff() : null;
}

/** The page's one handoff, built on first use, so importing the module reads no page globals. */
function getPageSessionHandoff(): SessionHandoff {
  pageHandoff ??= createSessionHandoff({
    open: (url, name) => window.open(url, name),
    listen: listenToMessages,
    onReturn: listener => listenForPageReturn({ visibility: document, target: window, handler: listener }),
    randomId: () => crypto.randomUUID(),
    windowOrigin: getProtocolOrigin(),
    network: getNetwork,
    presence: sessionPresence,
  });
  return pageHandoff;
}

/** What a sign-in round makes of the window's word, or null for a result that is no sign-in. */
function hearSignIn(word: WindowWord): SignInOutcome | null {
  switch (word.kind) {
    case 'refused':
      return { kind: 'refused' };
    case 'result': {
      // A result that is no sign-in leaves the round open, as a malformed message would.
      const result = parseSessionResult(word.result);
      return result === null ? null : { kind: 'result', result };
    }
  }
}

function getRoundTags(ended: RoundEnd<SignInOutcome>): RoundTags {
  if ('word' in ended) {
    return { outcome: getWordOutcome(ended.word), reason: 'window' };
  }
  if (ended.reason === 'signed_in') {
    // A page that hears the window store its sign-in, as one sharing the store does, ends the round before the
    // result comes, which is still a sign-in through the window.
    return { outcome: 'signed_in', reason: 'store' };
  }
  return { outcome: 'cancelled', reason: ended.reason };
}

function getWordOutcome(word: SignInOutcome): 'signed_in' | 'refused' {
  switch (word.kind) {
    case 'result':
      return 'signed_in';
    case 'refused':
    case 'blocked':
    case 'cancelled':
      return 'refused';
  }
}
