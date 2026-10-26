// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { must, recordLog } from '@dotli/shared/testing';
import { SIGNED_OUT_RESULT, type SessionResult } from './messages.js';
import { createFakeMessageBus, createFakeWindowHandle, type FakeWindowHandle } from './messages.fake.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import { openerParty, type OpenerParty } from './opener-rule.js';
import { createResponder, type ResponderState } from './responder.js';

const SELF = 'https://dot.li';
const PAGE = 'https://browse.dot.li';
const PRODUCT = 'https://x.app.dot.li';
const SITE = 'https://example.com';
const OTHER_SITE = 'https://elsewhere.example';

const RESULT: SessionResult = { session: { blob: '0xsession', uiState: null }, localWallet: null };

const READY = { type: 'dotli:s:ready', versions: [1] };

const hello = (round: string, v = 1) => ({ type: 'dotli:s:hello', v, round });

const payload = (round: string, call: unknown) => ({ type: 'dotli:s:payload', round, call });

/**
 * A responder over a fake browser for a request of round `r1`: its opener, a message bus and the page's return from the
 * back-forward cache.
 */
function harness<R = SessionResult>(
  options: { opener?: FakeWindowHandle | null; judge?: (origin: string) => OpenerParty } = {},
) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const warnings = recordLog({ onFinished: onTestFinished, level: 'warn' });
  const opener = options.opener === undefined ? createFakeWindowHandle() : options.opener;
  const messages = createFakeMessageBus();
  const pageRestores = createFakePageEvents();
  const responder = createResponder<R>({
    opener,
    judge: options.judge ?? (origin => openerParty(origin, SELF)),
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
    expect(window.states).toEqual([{ kind: 'vetted', origin: PAGE, party: 'first' }]);
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

  it('As an operator, I see a refused foreign opener of the sign-in window counted under a bounded reason, never its host', () => {
    // Given an open window
    const window = harness();

    // When a hello comes from a foreign origin over plain http
    window.post({ data: hello('r1'), origin: 'http://attacker-chosen-name.example', source: window.opener });

    // Then it is counted as insecure with no host
    expect(window.metrics.counted('session_window.refused')).toEqual([{ outcome: 'refused', reason: 'insecure' }]);
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
    expect(window.responder.state()).toEqual({ kind: 'vetted', origin: PAGE, party: 'first' });
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

  it('As a session window opened by a site, I vet it as a third party and the state names that party', () => {
    // Given an open window and its opener
    const window = harness();
    const opener = must(window.opener, 'an opener');

    // When a site says hello
    window.post({ data: hello('r1'), origin: SITE, source: opener });

    // Then the window is vetted for that site as a third party, and nothing more is said
    expect(window.states).toEqual([{ kind: 'vetted', origin: SITE, party: 'third' }]);
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it('As a session window, I refuse a vetted site with a reason and only that site hears it', () => {
    // Given a window vetted for a site
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });

    // When the round is refused
    window.responder.refuse('bad_request');

    // Then the refusal with its reason went to the site, and the round ended refused
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }, target: SITE },
    ]);
    expect(window.responder.state()).toEqual({ kind: 'refused' });
  });

  it('As a user in a session window, I cancel and only the vetted site hears it', () => {
    // Given a window vetted for a site
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });

    // When the user cancels
    window.responder.cancel();

    // Then the cancel went to the site as the round's last word
    expect(opener.posted.slice(1)).toEqual([{ message: { type: 'dotli:s:cancelled', round: 'r1' }, target: SITE }]);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a session window not yet vetted, I am asked to refuse and to cancel and say nothing, since I know no origin', () => {
    // Given an open window its opener has not greeted
    const window = harness();
    const opener = must(window.opener, 'an opener');

    // When the round is refused and cancelled
    window.responder.refuse('declined');
    window.responder.cancel();

    // Then only ready went out, and the window still waits
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
  });

  it('As a session window, I send a result with a site token and the token travels beside the result', () => {
    // Given a window vetted for a site
    const window = harness<{ ok: boolean }>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });

    // When the result is sent with a site token
    window.responder.send({ ok: true }, 'tok');

    // Then the result carries the token
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: { ok: true }, site_token: 'tok' }, target: SITE },
    ]);
  });

  it('As a session window that sent its result, I am asked to cancel and to refuse and say nothing more', () => {
    // Given a window that sent its result to a site
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    window.responder.send(RESULT);

    // When the round is cancelled, refused and sent again
    window.responder.cancel();
    window.responder.refuse('declined');
    window.responder.send(RESULT);

    // Then the result was the only word after ready, and the window stays answered
    expect(opener.posted.map(posted => (posted.message as { type: string }).type)).toEqual([
      'dotli:s:ready',
      'dotli:s:result',
    ]);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it.each([
    [
      'refused',
      (window: ReturnType<typeof harness>) => {
        window.responder.refuse('declined');
      },
    ],
    [
      'cancelled',
      (window: ReturnType<typeof harness>) => {
        window.responder.cancel();
      },
    ],
  ])('As a session window whose round was %s, I am asked for more and say nothing more', (_name, end) => {
    // Given a window vetted for a site whose round ended
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    end(window);
    const posted = opener.posted.length;

    // When the round is sent, refused and cancelled
    window.responder.send(RESULT);
    window.responder.refuse('bad_request');
    window.responder.cancel();

    // Then nothing more went out
    expect(opener.posted).toHaveLength(posted);
  });

  it('As a restored session window, I refuse while waiting to be vetted again and the first origin hears it', () => {
    // Given a window vetted for a site, restored from the back-forward cache
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    window.restorePage();

    // When the round is refused before the site says hello again
    window.responder.refuse('declined');

    // Then the refusal went to the site the window was vetted for
    expect(opener.posted.at(-1)).toEqual({
      message: { type: 'dotli:s:refused', round: 'r1', reason: 'declined' },
      target: SITE,
    });
    expect(window.responder.state()).toEqual({ kind: 'refused' });
  });

  it('As a sign-out window opened by a site, I hold my read past the vetting and a refusal is all the site hears', () => {
    // Given a sign-out window that read before its opener said hello
    const window = harness<typeof SIGNED_OUT_RESULT>();
    const opener = must(window.opener, 'an opener');
    window.responder.send(SIGNED_OUT_RESULT);

    // When a site says hello and the round is refused
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    const vetted = window.responder.state();
    window.responder.refuse('bad_request');

    // Then the vetting sent nothing, and only the refusal went out
    expect(vetted).toEqual({ kind: 'vetted', origin: SITE, party: 'third' });
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }, target: SITE },
    ]);
  });

  it('As a sign-out window opened by a site, I am restored and vetted again and my read from before the first vetting never reaches the site', () => {
    // Given a sign-out window that read before a site vetted it, restored from the back-forward cache
    const window = harness<typeof SIGNED_OUT_RESULT>();
    const opener = must(window.opener, 'an opener');
    window.responder.send(SIGNED_OUT_RESULT);
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    window.restorePage();

    // When the site says hello again
    window.post({ data: hello('r1'), origin: SITE, source: opener });

    // Then it is vetted again and heard only ready twice
    expect(window.responder.state()).toEqual({ kind: 'vetted', origin: SITE, party: 'third' });
    expect(opener.posted.map(posted => posted.message)).toEqual([READY, READY]);
  });

  it("As a window restored after its opener moved to another site, I ignore the new origin's hello and keep my result for the first", () => {
    // Given a window vetted for a dotli page, restored from the back-forward cache with its result finished
    const window = harness();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: PAGE, source: opener });
    window.restorePage();
    window.responder.send(RESULT);

    // When the opener, now on another site, says hello, and then the first page says hello again
    window.post({ data: hello('r1'), origin: OTHER_SITE, source: opener });
    const afterOther = { state: window.responder.state(), posted: opener.posted.length };
    window.post({ data: hello('r1'), origin: PAGE, source: opener });

    // Then the other site changed nothing and was not refused, and the result went to the first page alone
    expect(afterOther).toEqual({ state: { kind: 'connecting' }, posted: 2 });
    expect(window.metrics.counted('session_window.refused')).toEqual([]);
    expect(opener.posted.slice(2)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: RESULT }, target: PAGE },
    ]);
  });

  it("As a sign window, I get a site's payload after the vetting and keep its call for when it is asked for", async () => {
    // Given a window vetted for a site
    const window = harness<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });

    // When the site sends its payload, and only then is the call asked for
    window.post({ data: payload('r1', '0x0a03'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then the call is the payload's, and nothing was said back
    expect(call).toBe('0x0a03');
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it.each<[string, (window: ReturnType<typeof harness<unknown>>, opener: FakeWindowHandle) => void]>([
    [
      'before the vetting',
      (window, opener) => {
        window.post({ data: payload('r1', '0xdead'), origin: SITE, source: opener });
        window.post({ data: hello('r1'), origin: SITE, source: opener });
      },
    ],
    [
      'from another origin',
      (window, opener) => {
        window.post({ data: hello('r1'), origin: SITE, source: opener });
        window.post({ data: payload('r1', '0xdead'), origin: OTHER_SITE, source: opener });
      },
    ],
    [
      'from another window',
      (window, opener) => {
        window.post({ data: hello('r1'), origin: SITE, source: opener });
        window.post({ data: payload('r1', '0xdead'), origin: SITE, source: createFakeWindowHandle() });
      },
    ],
    [
      'for another round',
      (window, opener) => {
        window.post({ data: hello('r1'), origin: SITE, source: opener });
        window.post({ data: payload('r2', '0xdead'), origin: SITE, source: opener });
      },
    ],
    [
      'whose call is not a string',
      (window, opener) => {
        window.post({ data: hello('r1'), origin: SITE, source: opener });
        window.post({ data: payload('r1', 7), origin: SITE, source: opener });
      },
    ],
  ])('As a sign window, I ignore a payload %s and keep the first one that counts', async (_name, ignored) => {
    // Given a window and a payload it must ignore
    const window = harness<unknown>();
    const opener = must(window.opener, 'an opener');
    ignored(window, opener);

    // When the vetted site sends its payload
    window.post({ data: payload('r1', '0x0a03'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then the call is the one that counts
    expect(call).toBe('0x0a03');
  });

  it('As a sign window, I get a second payload and keep the first', async () => {
    // Given a window vetted for a site that sent its payload
    const window = harness<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    window.post({ data: payload('r1', '0x0a03'), origin: SITE, source: opener });

    // When the site sends another
    window.post({ data: payload('r1', '0xdead'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then the first one counts
    expect(call).toBe('0x0a03');
  });

  it('As a sign window restored from the back-forward cache, I get the payload again after the new ready and keep the first', async () => {
    // Given a window vetted for a site that sent its payload, restored and vetted again
    const window = harness<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    window.post({ data: payload('r1', '0x0a03'), origin: SITE, source: opener });
    window.restorePage();
    window.post({ data: hello('r1'), origin: SITE, source: opener });

    // When the site answers the new ready with its payload again, now another call
    window.post({ data: payload('r1', '0xdead'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then the first one counts, and the window is vetted again
    expect(call).toBe('0x0a03');
    expect(window.responder.state()).toEqual({ kind: 'vetted', origin: SITE, party: 'third' });
  });

  it('As a sign window restored before its payload came, I take the first payload after the first vetting', async () => {
    // Given a window vetted for a site, restored before any payload and waiting to be vetted again
    const window = harness<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: hello('r1'), origin: SITE, source: opener });
    window.restorePage();

    // When the site sends its payload before its new hello
    window.post({ data: payload('r1', '0x0a03'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then it counts, since the window was vetted once
    expect(call).toBe('0x0a03');
  });
});
