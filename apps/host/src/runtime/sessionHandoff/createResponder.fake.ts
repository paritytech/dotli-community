// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Responders a spec runs a site's round over: one that records what the window posts, and the window's real one over a
// fake opener, vetted by the site.

import { registerStoreStateReset } from '@dotli/shared';
import { atom } from 'nanostores';
import { createFakePageEvents } from '../../testing/pageEvents.js';
import { createResponder, type Responder, type ResponderState } from './createResponder.js';
import { createFakeMessageBus, createFakeWindowHandle } from './listenToMessages.fake.js';
import { getOpenerParty } from './openerRule.js';
import {
  createHelloMessage,
  type CancelledMessage,
  type RefusedMessage,
  type ResultMessage,
} from './sessionMessages.js';

/** One message the window posted to its opener, without the round it answers. */
export type SiteRoundPost =
  Omit<ResultMessage<unknown>, 'round'> | Omit<RefusedMessage, 'round'> | Omit<CancelledMessage, 'round'>;

type CreateRecordingResponderParams = {
  /** The vetted site's origin. */
  origin: string;
  /** Told each time a result is held for the next vetting. */
  onHeld?: () => void;
};

type CreateVettedResponderParams = {
  /** The origin of the site that opened the window and said hello. */
  origin: string;
  /** The window's own origin, which the opener's party is judged against. */
  self: string;
};

/**
 * A responder that records what it posts, ends its round on its first terminal call and holds a result sent while the
 * window waits to be vetted again, which goes out with that vetting.
 */
export function createRecordingResponder({ origin, onHeld }: CreateRecordingResponderParams) {
  const posts: SiteRoundPost[] = [];
  const vetted: ResponderState = { kind: 'vetted', origin, party: 'third' };
  const round = atom<ResponderState>(vetted);
  registerStoreStateReset(() => {
    round.set(vetted);
  });
  let held: SiteRoundPost | null = null;
  function end(post: SiteRoundPost, state: ResponderState): void {
    const { kind } = round.get();
    if (kind === 'answered' || kind === 'refused') {
      return;
    }
    held = null;
    posts.push(post);
    round.set(state);
  }
  const responder: Pick<Responder<unknown>, 'send' | 'refuse' | 'cancel' | 'state' | 'dispose'> = {
    state: round,
    send(result, { siteToken } = {}) {
      const post: SiteRoundPost = {
        type: 'dotli:s:result',
        result,
        ...(siteToken === undefined ? {} : { site_token: siteToken }),
      };
      if (round.get().kind === 'connecting') {
        held = post;
        onHeld?.();
        return;
      }
      end(post, { kind: 'answered' });
    },
    refuse(reason) {
      end({ type: 'dotli:s:refused', reason }, { kind: 'refused' });
    },
    cancel() {
      end({ type: 'dotli:s:cancelled' }, { kind: 'answered' });
    },
    dispose: () => undefined,
  };
  /** The window comes back from the back-forward cache and waits to be vetted again. */
  function restore(): void {
    round.set({ kind: 'connecting' });
  }
  /** The site says hello again to the restored window, which sends a result it holds. */
  function sayHelloAgain(): void {
    if (held === null) {
      round.set(vetted);
    } else {
      end(held, { kind: 'answered' });
    }
  }
  return {
    responder,
    /** Every message posted, in order. */
    posts,
    /** Whether a result waits for the window to be vetted again. */
    isHolding: () => held !== null,
    restore,
    sayHelloAgain,
  };
}

/** The window's real responder for round `r1` over a fake opener and message bus, which `origin` vetted by its hello. */
export function createVettedResponder({ origin, self }: CreateVettedResponderParams) {
  const opener = createFakeWindowHandle();
  const messages = createFakeMessageBus();
  const responder = createResponder<unknown>({
    opener,
    judge: candidate => getOpenerParty(candidate, self),
    round: 'r1',
    listen: messages.listen,
    onPageRestore: createFakePageEvents().subscribe,
  });
  messages.post({ data: createHelloMessage('r1'), origin, source: opener });
  return {
    responder,
    /** The site's window, which holds every message the responder posted to it. */
    opener,
    /** Delivers a message event to the window's page. */
    post: messages.post,
  };
}
