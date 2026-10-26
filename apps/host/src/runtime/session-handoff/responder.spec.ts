// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { must, recordLog } from '@dotli/shared/testing';
import { SIGNED_OUT_RESULT, type SessionResult } from './messages.js';
import { createFakeMessageBus, createFakeWindowHandle, type FakeWindowHandle } from './messages.fake.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import { createResponder, type ResponderState } from './responder.js';

const SELF = 'https://dot.li';
const PAGE = 'https://browse.dot.li';
const PRODUCT = 'https://x.app.dot.li';

const RESULT: SessionResult = { session: { blob: '0xsession', uiState: null }, localWallet: null };

const READY = { type: 'dotli:s:ready', versions: [1] };

const hello = (round: string, v = 1) => ({ type: 'dotli:s:hello', v, round });

/**
 * A responder over a fake browser for a request of round `r1`: its opener, a message bus and the page's return from the
 * back-forward cache.
 */
function harness<R = SessionResult>(options: { opener?: FakeWindowHandle | null } = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const warnings = recordLog({ onFinished: onTestFinished, level: 'warn' });
  const opener = options.opener === undefined ? createFakeWindowHandle() : options.opener;
  const messages = createFakeMessageBus();
  const pageRestores = createFakePageEvents();
  const responder = createResponder<R>({
    opener,
    self: SELF,
    round: 'r1',
    listen: messages.listen,
    onPageRestore: pageRestores.subscribe,
  });
  const states: ResponderState[] = [];
  responder.subscribe(state => {
    states.push(state);
  });
  return {
    responder,
    opener,
    metrics,
    warnings,
    states,
    post: messages.post,
    /** The page coming back from the back-forward cache. */
    restorePage: pageRestores.fire,
    listeners: () => messages.size + pageRestores.size,
  };
}

describe('session window responder', () => {
  it('As a user in the sign-in window, I open it and it says ready and waits without showing any account', () => {
    // Given an opener
    const opener = createFakeWindowHandle();

    // When the window opens
    const window = harness({ opener });

    // Then ready went to my opener whatever its origin, naming only the versions it speaks, and I wait
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
  });

  it('As a user in the sign-in window, I open it and it takes hello only from its opener on an allowed origin', () => {
    // Given an open window and its opener
    const window = harness();
    const opener = must(window.opener, 'an opener');

    // When hello comes from another window, in a junk shape, and then from my opener on a dotli page
    window.post({ data: hello('r1'), origin: PAGE, source: createFakeWindowHandle() });
    window.post({ data: { type: 'dotli:s:hello', v: '1', round: 'r1' }, origin: PAGE, source: opener });
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // Then only my opener's hello counts, and the result goes back to its origin alone, with its round
    expect(window.states).toEqual([{ kind: 'vetted', origin: PAGE }]);
    window.responder.send(RESULT);
    expect(opener.posted.at(-1)).toEqual({
      message: { type: 'dotli:s:result', round: 'r1', result: RESULT },
      target: PAGE,
    });
  });

  it('As a window, I ignore a hello for another round and stay on Connecting', () => {
    // Given an open window for round r1
    const window = harness();
    const opener = must(window.opener, 'an opener');

    // When my opener says hello for another round
    window.post({ data: hello('r2'), origin: PAGE, source: opener });

    // Then nothing changed and nothing more was said
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
    expect(window.states).toEqual([]);
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it('As a window, I ignore a hello with another protocol version and stay on Connecting', () => {
    // Given an open window
    const window = harness();
    const opener = must(window.opener, 'an opener');

    // When my opener says hello for my round on another version, even from an origin the rule rejects
    window.post({ data: hello('r1', 2), origin: PAGE, source: opener });
    window.post({ data: hello('r1', 2), origin: PRODUCT, source: opener });

    // Then nothing changed, nothing was refused and nothing more was said
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
    expect(window.metrics.counted('session_window.refused')).toEqual([]);
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it('As a window, I refuse an opener the rule rejects and tell that origin only', () => {
    // Given an open window and its opener
    const window = harness();
    const opener = must(window.opener, 'an opener');

    // When a product origin says hello, and then a dotli page tries the same window
    window.post({ data: hello('r1'), origin: PRODUCT, source: opener });
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // Then I refused for good, told only that origin the round and why, and counted why under a closed set of reasons
    expect(window.responder.state()).toEqual({ kind: 'refused' });
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:refused', round: 'r1', reason: 'origin_not_allowed' }, target: PRODUCT },
    ]);
    expect(window.metrics.counted('session_window.refused')).toEqual([{ outcome: 'refused', reason: 'app' }]);
    expect(window.warnings).toHaveLength(1);
    expect(window.warnings[0]?.message).toBe(`[dot.li] Session window refused its opener (app): ${PRODUCT}`);
  });

  it('As a user in a sign-in window with no opener, I open it and it goes to the no-opener flow', () => {
    // Given no opener
    const opener = null;

    // When the window opens
    const window = harness({ opener });

    // Then I listen to nobody, and a result has nowhere to go
    expect(window.responder.state()).toEqual({ kind: 'no-opener' });
    expect(window.listeners()).toBe(0);
    window.responder.send(RESULT);
    expect(window.responder.state()).toEqual({ kind: 'no-opener' });
  });

  it('As a user in the sign-in window, I finish and the result is sent once with nothing more said', () => {
    // Given a window its opener vetted
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // When the result is sent twice and another hello comes
    window.responder.send(RESULT);
    window.responder.send(RESULT);
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // Then the result was the last word, sent once
    expect(opener.posted.slice(1).map(posted => (posted.message as { type: string }).type)).toEqual(['dotli:s:result']);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a sign-out window, I hold my read until the opener is vetted and then send an empty result', () => {
    // Given a sign-out window whose opener has not said hello yet
    const window = harness<typeof SIGNED_OUT_RESULT>();
    const opener = must(window.opener, 'an opener');

    // When the window reads twice before the hello, then the opener is vetted
    window.responder.send(SIGNED_OUT_RESULT);
    window.responder.send(SIGNED_OUT_RESULT);
    const postedBefore = opener.posted.length;
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // Then nothing went out before the vetting, and the empty result went to the vetted origin once
    expect(postedBefore).toBe(1);
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: {} }, target: PAGE },
    ]);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As an operator, I see a foreign opener of the sign-in window counted under a bounded reason, never its host', () => {
    // Given an open window
    const window = harness();

    // When a hello comes from a foreign origin
    window.post({ data: hello('r1'), origin: 'https://attacker-chosen-name.example', source: window.opener });

    // Then it is counted as foreign with no host
    expect(window.metrics.counted('session_window.refused')).toEqual([{ outcome: 'refused', reason: 'foreign' }]);
  });

  it('As a user in a sign-in window restored from the back-forward cache before it answered, I return to it and it says ready again and finishes', () => {
    // Given a vetted round, whose page went into the back-forward cache
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // When the page comes back and the opener answers its ready with the round it still holds
    window.restorePage();
    window.post({ data: hello('r1'), origin: PAGE, source: opener });
    window.responder.send(RESULT);

    // Then the opener heard ready twice and then the result
    expect(opener.posted.map(posted => (posted.message as { type: string }).type)).toEqual([
      'dotli:s:ready',
      'dotli:s:ready',
      'dotli:s:result',
    ]);
    expect(window.states.map(state => state.kind)).toEqual(['vetted', 'connecting', 'vetted', 'answered']);
  });

  it('As a user in a restored sign-in window, I return to it and a hello for another round is ignored while my own round vets me again', () => {
    // Given a vetted window, restored from the back-forward cache
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: PAGE, source: opener });
    window.restorePage();

    // When the opener says hello for another round, and then for my request's round
    window.post({ data: hello('r2'), origin: PAGE, source: opener });
    const afterOtherRound = window.responder.state();
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // Then the other round changed nothing, and my own round vetted me again
    expect(afterOtherRound).toEqual({ kind: 'connecting' });
    expect(window.responder.state()).toEqual({ kind: 'vetted', origin: PAGE });
  });

  it('As a user in a restored sign-in window whose result was finished before the vetting, I return to it and the result is sent with that vetting', () => {
    // Given a restored window waiting for its opener again
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: PAGE, source: opener });
    window.restorePage();

    // When the result is finished first and the opener answers after
    window.responder.send(RESULT);
    const postedBefore = opener.posted.length;
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // Then it went out with the vetting, to the vetted origin and round, once
    expect(postedBefore).toBe(2);
    expect(opener.posted.slice(2)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: RESULT }, target: PAGE },
    ]);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a user in a restored sign-in window that already sent its result, I return to it and nothing more is said', () => {
    // Given a window that already sent its result
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: PAGE, source: opener });
    window.responder.send(RESULT);

    // When the page is restored
    window.restorePage();

    // Then nothing more is posted and the window stays answered
    expect(opener.posted).toHaveLength(2);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a user in a restored sign-in window that refused its opener, I return to it and nothing starts again', () => {
    // Given a window that refused an app origin
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: PRODUCT, source: opener });

    // When the page is restored
    window.restorePage();

    // Then it stays refused and posts nothing more
    expect(window.responder.state()).toEqual({ kind: 'refused' });
    expect(opener.posted).toHaveLength(2);
  });
});
