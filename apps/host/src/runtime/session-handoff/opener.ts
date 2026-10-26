// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of the sign-in window: it opens the window from the click, answers the window's `ready` and takes
// the window's reply. The browser vouches for who speaks, so a reply counts only from the window this page opened, on
// the root origin, for the round this page started. A sign-out opens the sign-out window and drops the signed-in flag
// in the click's turn, and answers that window's read to whoever asks.

import { getNetwork, type Network } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { getProtocolOrigin } from '@dotli/protocol';
import { deferred, log, onPageReturn } from '@dotli/shared';
import { signInSurface, type PageRole } from '../page-role.js';
import { sessionPresence, type SessionPresence } from '../session/presence.js';
import {
  listenToMessages,
  parseWindowMessage,
  signInWindowUrl,
  signOutWindowUrl,
  type MessageEventLike,
  type OpenerMessage,
  type SessionResult,
  type SignInIntent,
  type WindowHandle,
  type WindowMessage,
} from './messages.js';

export type SignInOutcome =
  { kind: 'result'; result: SessionResult } | { kind: 'blocked' } | { kind: 'cancelled' } | { kind: 'refused' };

/** Why the page ended its own round: the user's Cancel, or the page became signed in by another route. */
export type PageCancelReason = 'page' | 'signed_in';

export interface SessionHandoff {
  /**
   * Opens the window synchronously, in place of a sign-in window this page still has open. While the sign-out window is
   * open, it brings that window to the front and answers cancelled, since the sign-out has yet to read or tell the
   * phone.
   */
  signIn(intent: SignInIntent): Promise<SignInOutcome>;
  /**
   * Opens the sign-out window and drops the signed-in flag, both before this returns. A call while the sign-out window
   * is open focuses it and leaves the flag alone.
   */
  signOut(options: { notified: boolean }): void;
  /**
   * Settles once the open sign-out window has read what it ends, so the page may clear its own copy without taking the
   * session from under it, or once the page finds that window closed when it never said so. Settled at once when no
   * sign-out window is open, also when the browser blocked it.
   */
  signOutRead(): Promise<void>;
  /** Brings the open round's window to the front, or ends the round when that window is gone. */
  focus(): void;
  /** Ends the open round and closes its window, counted under `reason`. */
  cancel(reason: PageCancelReason): void;
}

export interface HandoffDeps {
  open: (url: string, name: string) => WindowHandle | null;
  listen: (handler: (event: MessageEventLike) => void) => () => void;
  /** Focus and visibility events of the opener's own page. */
  onReturn: (listener: () => void) => () => void;
  randomId: () => string;
  windowOrigin: string;
  network: () => Network;
  /**
   * The signed-in flag, which a sign-out through the window drops. Never rejects, and reports its own failed writes.
   */
  presence: Pick<SessionPresence, 'clear'>;
}

// One name, so a second open reuses the window instead of stacking another.
const WINDOW_NAME = 'dotli-session';

/** Why a round ended without the window's word. A window opened in place of the round's ends it as `page`. */
type CancelReason = 'closed' | 'signed_out' | PageCancelReason;

/** What the page waits for on its open window: a sign-in round's outcome, or a sign-out window's read. */
type WindowWait = { readonly kind: 'signin' } | { readonly kind: 'signout'; readonly read: Promise<void> };

/** The one window the page has open. */
type OpenWindow = WindowWait & {
  readonly handle: WindowHandle;
  /** Settles what the page waits for on the window, as cancelled for a round. Only the open window ends, once. */
  end(reason: CancelReason): void;
};

/** How a sign-in round ended and what ended it, as its metric tags them. */
function roundTags(ended: { word: SignInOutcome } | { reason: CancelReason }): {
  outcome: 'signed_in' | 'refused' | 'cancelled';
  reason: 'window' | 'store' | Exclude<CancelReason, 'signed_in'>;
} {
  if ('word' in ended) {
    return { outcome: ended.word.kind === 'result' ? 'signed_in' : 'refused', reason: 'window' };
  }
  if (ended.reason === 'signed_in') {
    // A page that hears the window store its sign-in, as one sharing the store does, ends the round before the
    // result comes, which is still a sign-in through the window.
    return { outcome: 'signed_in', reason: 'store' };
  }
  return { outcome: 'cancelled', reason: ended.reason };
}

export function createSessionHandoff(deps: HandoffDeps): SessionHandoff {
  let current: OpenWindow | null = null;

  /**
   * Hears `handle` until the returned stop: its messages from the root origin, and the page coming back to find it
   * closed, which is when a user who closed it returns. Only the handle says a window is gone, as a document that goes
   * may be a reload or a trip through the back-forward cache.
   */
  const watchWindow = (
    handle: WindowHandle,
    onMessage: (message: WindowMessage) => void,
    onClosed: () => void,
  ): (() => void) => {
    const stopListening = deps.listen(event => {
      if (event.source !== handle || event.origin !== deps.windowOrigin) {
        return;
      }
      const message = parseWindowMessage(event.data);
      if (message !== null) {
        onMessage(message);
      }
    });
    const stopReturn = deps.onReturn(() => {
      if (handle.closed) {
        onClosed();
      }
    });
    return () => {
      stopListening();
      stopReturn();
    };
  };

  /**
   * Opens the window in place of the one open, which ends, and makes it the open one until it settles, once: with the
   * window's word, or with the reason it ended without one. Some pop-up blockers hand back a window that is already
   * closed instead of none.
   */
  const open = <Word>(
    wait: WindowWait,
    url: string,
    settle: (ended: { word: Word } | { reason: CancelReason }) => void,
    hear: (message: WindowMessage, handle: WindowHandle) => Word | null,
  ): WindowHandle | null => {
    current?.end('page');
    const handle = deps.open(url, WINDOW_NAME);
    if (handle === null || handle.closed) {
      return null;
    }
    const finish = (ended: { word: Word } | { reason: CancelReason }): void => {
      if (current !== opened) {
        return;
      }
      current = null;
      stop();
      settle(ended);
    };
    const opened: OpenWindow = {
      ...wait,
      handle,
      end: reason => {
        finish({ reason });
      },
    };
    current = opened;
    const stop = watchWindow(
      handle,
      message => {
        const word = hear(message, handle);
        if (word !== null) {
          finish({ word });
        }
      },
      () => {
        finish({ reason: 'closed' });
      },
    );
    return handle;
  };

  return {
    signIn(intent) {
      if (current?.kind === 'signout') {
        current.handle.focus();
        log.event('sign-in window refused while signing out', { flow: 'wallet' });
        m.count(S.SESSION_WINDOW_SIGNIN, { outcome: 'busy', reason: intent });
        return Promise.resolve({ kind: 'cancelled' });
      }
      const id = deps.randomId();
      const outcome = deferred<SignInOutcome>();
      const handle = open<SignInOutcome>(
        { kind: 'signin' },
        signInWindowUrl(intent, deps.network(), deps.windowOrigin),
        ended => {
          const settled: SignInOutcome = 'word' in ended ? ended.word : { kind: 'cancelled' };
          log.event('sign-in window round ended', { flow: 'wallet', outcome: settled.kind });
          m.count(S.SESSION_WINDOW_ROUND, roundTags(ended));
          outcome.resolve(settled);
        },
        (message, window) => {
          // A reloaded or restored window says ready again and gets the same round.
          if (message.type === 'dotli:session:ready') {
            const hello: OpenerMessage = { type: 'dotli:session:hello', round: id, intent };
            window.postMessage(hello, deps.windowOrigin);
            return null;
          }
          if (message.type === 'dotli:session:signed-out-read' || message.round !== id) {
            return null;
          }
          return message.type === 'dotli:session:result'
            ? { kind: 'result', result: message.result }
            : { kind: 'refused' };
        },
      );
      if (handle === null) {
        log.event('sign-in window blocked', { flow: 'wallet' });
        m.count(S.SESSION_WINDOW_SIGNIN, { outcome: 'blocked', reason: intent });
        return Promise.resolve({ kind: 'blocked' });
      }
      m.count(S.SESSION_WINDOW_SIGNIN, { outcome: 'opened', reason: intent });
      return outcome.promise;
    },
    signOut({ notified }) {
      if (current?.kind === 'signout') {
        current.handle.focus();
        return;
      }
      // The sign-out window takes the sign-in window's name, so a round left open would answer its `ready`.
      current?.end('signed_out');
      const read = deferred<undefined>();
      // A blocked window never becomes `current`, so its read is the settled one `signOutRead` gives.
      const handle = open<true>(
        { kind: 'signout', read: read.promise },
        signOutWindowUrl(notified, deps.network(), deps.windowOrigin),
        () => {
          read.resolve(undefined);
        },
        message => (message.type === 'dotli:session:signed-out-read' ? true : null),
      );
      m.count(S.SESSION_WINDOW_SIGNOUT, {
        outcome: handle === null ? 'blocked' : 'opened',
        reason: notified ? 'notified' : 'unnotified',
      });
      // In the window's own turn, so the flag is gone before its document loads and its restore rule finds the store
      // dead. A blocked window still signs the page out.
      void deps.presence.clear();
    },
    signOutRead() {
      return current?.kind === 'signout' ? current.read : Promise.resolve();
    },
    focus() {
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
    cancel(reason) {
      const round = current;
      if (round?.kind !== 'signin') {
        return;
      }
      round.end(reason);
      round.handle.close();
    },
  };
}

let pageHandoff: SessionHandoff | undefined;

/** The page's one handoff, built on first use, so importing the module reads no page globals. */
function pageSessionHandoff(): SessionHandoff {
  pageHandoff ??= createSessionHandoff({
    open: (url, name) => window.open(url, name),
    listen: listenToMessages,
    onReturn: listener => onPageReturn(document, window, listener),
    randomId: () => crypto.randomUUID(),
    windowOrigin: getProtocolOrigin(),
    network: getNetwork,
    presence: sessionPresence,
  });
  return pageHandoff;
}

/** The page's handoff when `role` signs in through the sign-in window, else null for a page that pairs in place. */
export function pageSignInHandoff(role: PageRole): SessionHandoff | null {
  return signInSurface(role) === 'window' ? pageSessionHandoff() : null;
}
