// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { isRecord } from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import type { SessionResult } from './parseSessionResult.js';
import { SIGNED_OUT_RESULT } from './roundAnswer.js';
import { createFakeMessageBus, createFakeWindowHandle, type FakeWindowHandle } from './listenToMessages.fake.js';
import { createFakePageEvents } from '../../testing/pageEvents.js';
import { getOpenerParty, type OpenerParty } from './openerRule.js';
import { createResponder, type ResponderState } from './createResponder.js';

type OpenWindowParams = {
  /** The window's opener, a fake one by default, or null for a window no page opened. */
  opener?: FakeWindowHandle | null;
  /** The party of a hello's origin, judged against the window's own origin by default. */
  judge?: (origin: string) => OpenerParty;
};

type CreateHelloParams = {
  /** The protocol version the hello names, 1 by default. */
  version?: number;
};

const SELF = 'https://dot.li';
const PAGE = 'https://browse.dot.li';
const PRODUCT = 'https://x.app.dot.li';
const SITE = 'https://example.com';
const OTHER_SITE = 'https://elsewhere.example';

const RESULT: SessionResult = { session: { blob: '0xsession', uiState: null }, localWallet: null };

/** The window's ready, as it must go out on the wire. */
const READY = { type: 'dotli:s:ready', versions: [1] };

/** An opener's hello for `round`, as an opener sends it, on protocol `version`. */
function createHello(round: string, { version = 1 }: CreateHelloParams = {}) {
  // A third-party site writes its hello itself, on any version, so this stands in for that site's wire.
  return { type: 'dotli:s:hello', v: version, round };
}

/** A site's payload for `round` carrying `call`, as a site sends it. */
function createPayload(round: string, call: unknown) {
  // A third-party site writes its payload itself, with no dotli builder, so this stands in for that site's wire.
  return { type: 'dotli:s:payload', round, call };
}

/** The type of each message posted to `handle`, in order. */
function getPostedTypes(handle: FakeWindowHandle): unknown[] {
  return handle.posted.map(({ message }) => (isRecord(message) ? message['type'] : undefined));
}

/**
 * A responder over a fake browser for a request of round `r1`: its opener, a message bus and the page's return from the
 * back-forward cache.
 */
function openWindow<Result = SessionResult>(options: OpenWindowParams = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const warnings = recordLog({ onFinished: onTestFinished, level: 'warn' });
  const opener = options.opener === undefined ? createFakeWindowHandle() : options.opener;
  const messages = createFakeMessageBus();
  const pageRestores = createFakePageEvents();
  const responder = createResponder<Result>({
    opener,
    judge: options.judge ?? (origin => getOpenerParty(origin, SELF)),
    round: 'r1',
    listen: messages.listen,
    onPageRestore: pageRestores.subscribe,
  });
  const states: ResponderState[] = [];
  onTestFinished(
    responder.subscribe(state => {
      states.push(state);
    }),
  );
  return {
    responder,
    opener,
    metrics,
    warnings,
    states,
    post: messages.post,
    /** The page coming back from the back-forward cache. */
    restorePage: pageRestores.fire,
    countListeners: () => messages.size + pageRestores.size,
  };
}

describe('session window responder', () => {
  it('As a user in the sign-in window, I open it and it says ready and waits without showing any account', () => {
    // Given an opener
    const opener = createFakeWindowHandle();

    // When the window opens
    const window = openWindow({ opener });

    // Then ready went to my opener whatever its origin, naming only the versions it speaks, and I wait
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
  });

  it('As a user in the sign-in window, I open it and it takes hello only from its opener on an allowed origin', () => {
    // Given an open window and its opener
    const window = openWindow();
    const opener = must(window.opener, 'an opener');

    // When hello comes from another window, in a junk shape, and then from my opener on a dotli page, and the window
    // then sends its result
    window.post({ data: createHello('r1'), origin: PAGE, source: createFakeWindowHandle() });
    window.post({ data: { type: 'dotli:s:hello', v: '1', round: 'r1' }, origin: PAGE, source: opener });
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });
    const statesOnHello = [...window.states];
    window.responder.send(RESULT);

    // Then only my opener's hello counts, and the result goes back to its origin alone, with its round
    expect(statesOnHello).toEqual([{ kind: 'vetted', origin: PAGE, party: 'first' }]);
    expect(opener.posted.at(-1)).toEqual({
      message: { type: 'dotli:s:result', round: 'r1', result: RESULT },
      target: PAGE,
    });
  });

  it('As a user in the sign-in window, I see a hello for another round ignored and stay on Connecting', () => {
    // Given an open window for round r1
    const window = openWindow();
    const opener = must(window.opener, 'an opener');

    // When my opener says hello for another round
    window.post({ data: createHello('r2'), origin: PAGE, source: opener });

    // Then nothing changed and nothing more was said
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
    expect(window.states).toEqual([]);
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it('As a user in the sign-in window, I see a hello of another protocol version ignored and stay on Connecting', () => {
    // Given an open window
    const window = openWindow();
    const opener = must(window.opener, 'an opener');

    // When my opener says hello for my round on another version, even from an origin the rule rejects
    window.post({ data: createHello('r1', { version: 2 }), origin: PAGE, source: opener });
    window.post({ data: createHello('r1', { version: 2 }), origin: PRODUCT, source: opener });

    // Then nothing changed, nothing was refused and nothing more was said
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
    expect(window.metrics.counted('session_window.refused')).toEqual([]);
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it('As a user in the sign-in window, I see an opener the rule rejects refused for good and only that origin told', () => {
    // Given an open window and its opener
    const window = openWindow();
    const opener = must(window.opener, 'an opener');

    // When a product origin says hello, and then a dotli page tries the same window
    window.post({ data: createHello('r1'), origin: PRODUCT, source: opener });
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // Then I refused for good, told only that origin the round and why, and counted why under a closed set of reasons
    expect(window.responder.state()).toEqual({ kind: 'refused' });
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:refused', round: 'r1', reason: 'origin_not_allowed' }, target: PRODUCT },
    ]);
    expect(window.metrics.counted('session_window.refused')).toEqual([{ outcome: 'refused', reason: 'app' }]);
    expect(window.warnings.map(warning => warning.message)).toEqual([
      `[dot.li] Session window refused its opener (app): ${PRODUCT}`,
    ]);
  });

  it('As a user in a sign-in window with no opener, I open it and it goes to the no-opener flow', () => {
    // Given no opener
    const opener = null;

    // When the window opens
    const window = openWindow({ opener });

    // Then I listen to nobody
    expect(window.responder.state()).toEqual({ kind: 'no-opener' });
    expect(window.countListeners()).toBe(0);

    // When a result is sent
    window.responder.send(RESULT);

    // Then it has nowhere to go
    expect(window.responder.state()).toEqual({ kind: 'no-opener' });
  });

  it('As a user in the sign-in window, I finish and the result is sent once with nothing more said', () => {
    // Given a window its opener vetted
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // When the result is sent twice and another hello comes
    window.responder.send(RESULT);
    window.responder.send(RESULT);
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // Then the result was the last word, sent once
    expect(getPostedTypes(opener).slice(1)).toEqual(['dotli:s:result']);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a user signing out in the sign-out window, I sign out before the opener is vetted and the empty result goes out once after the vetting', () => {
    // Given a sign-out window whose opener has not said hello yet
    const window = openWindow<typeof SIGNED_OUT_RESULT>();
    const opener = must(window.opener, 'an opener');

    // When the window reads twice before the hello, then the opener is vetted
    window.responder.send(SIGNED_OUT_RESULT);
    window.responder.send(SIGNED_OUT_RESULT);
    const postedBefore = opener.posted.length;
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // Then nothing went out before the vetting, and the empty result went to the vetted origin once
    expect(postedBefore).toBe(1);
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: {} }, target: PAGE },
    ]);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As an operator, I see a foreign opener of the sign-in window refused and counted under a bounded reason, never its host', () => {
    // Given an open window
    const window = openWindow();

    // When a hello comes from a foreign origin over plain http
    window.post({ data: createHello('r1'), origin: 'http://attacker-chosen-name.example', source: window.opener });

    // Then it is counted as insecure with no host
    expect(window.metrics.counted('session_window.refused')).toEqual([{ outcome: 'refused', reason: 'insecure' }]);
  });

  it('As a user in a sign-in window restored from the back-forward cache before it answered, I return to it and it says ready again and finishes', () => {
    // Given a vetted round, whose page went into the back-forward cache
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // When the page comes back and the opener answers its ready with the round it still holds
    window.restorePage();
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });
    window.responder.send(RESULT);

    // Then the opener heard ready twice and then the result
    expect(getPostedTypes(opener)).toEqual(['dotli:s:ready', 'dotli:s:ready', 'dotli:s:result']);
    expect(window.states.map(state => state.kind)).toEqual(['vetted', 'connecting', 'vetted', 'answered']);
  });

  it('As a user in a restored sign-in window, I return to it and a hello for another round is ignored while my own round vets me again', () => {
    // Given a vetted window, restored from the back-forward cache
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });
    window.restorePage();

    // When the opener says hello for another round, and then for my request's round
    window.post({ data: createHello('r2'), origin: PAGE, source: opener });
    const afterOtherRound = window.responder.state();
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // Then the other round changed nothing, and my own round vetted me again
    expect(afterOtherRound).toEqual({ kind: 'connecting' });
    expect(window.responder.state()).toEqual({ kind: 'vetted', origin: PAGE, party: 'first' });
  });

  it('As a user in a restored sign-in window whose result was finished before the vetting, I return to it and the result is sent with that vetting', () => {
    // Given a restored window waiting for its opener again
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });
    window.restorePage();

    // When the result is finished first and the opener answers after
    window.responder.send(RESULT);
    const postedBefore = opener.posted.length;
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // Then it went out with the vetting, to the vetted origin and round, once
    expect(postedBefore).toBe(2);
    expect(opener.posted.slice(2)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: RESULT }, target: PAGE },
    ]);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a user in a restored sign-in window that already sent its result, I return to it and nothing more is said', () => {
    // Given a window that already sent its result
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });
    window.responder.send(RESULT);

    // When the page is restored
    window.restorePage();

    // Then nothing more is posted and the window stays answered
    expect(opener.posted).toHaveLength(2);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a user in a restored sign-in window that refused its opener, I return to it and nothing starts again', () => {
    // Given a window that refused an app origin
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: PRODUCT, source: opener });

    // When the page is restored
    window.restorePage();

    // Then it stays refused and posts nothing more
    expect(window.responder.state()).toEqual({ kind: 'refused' });
    expect(opener.posted).toHaveLength(2);
  });

  it('As a site, I say hello to the session window and it vets me as a third party, naming that party', () => {
    // Given an open window and its opener
    const window = openWindow();
    const opener = must(window.opener, 'an opener');

    // When a site says hello
    window.post({ data: createHello('r1'), origin: SITE, source: opener });

    // Then the window is vetted for that site as a third party, and nothing more is said
    expect(window.states).toEqual([{ kind: 'vetted', origin: SITE, party: 'third' }]);
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it('As a site, I am refused by the session window with a reason and only I hear it', () => {
    // Given a window vetted for a site
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });

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
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });

    // When the user cancels
    window.responder.cancel();

    // Then the cancel went to the site as the round's last word
    expect(opener.posted.slice(1)).toEqual([{ message: { type: 'dotli:s:cancelled', round: 'r1' }, target: SITE }]);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a user in a session window not yet vetted, I cancel after a refusal and nothing is said, since no origin is known', () => {
    // Given an open window its opener has not greeted
    const window = openWindow();
    const opener = must(window.opener, 'an opener');

    // When the round is refused and cancelled
    window.responder.refuse('declined');
    window.responder.cancel();

    // Then only ready went out, and the window still waits
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
    expect(window.responder.state()).toEqual({ kind: 'connecting' });
  });

  it('As a site, I get a result with a site token from the session window and the token travels beside the result', () => {
    // Given a window vetted for a site
    const window = openWindow<{ ok: boolean }>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });

    // When the result is sent with a site token
    window.responder.send({ ok: true }, { siteToken: 'tok' });

    // Then the result carries the token
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: { ok: true }, site_token: 'tok' }, target: SITE },
    ]);
  });

  it('As a site, I get my result and a later cancel, refusal or second result never reaches me', () => {
    // Given a window that sent its result to a site
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
    window.responder.send(RESULT);

    // When the round is cancelled, refused and sent again
    window.responder.cancel();
    window.responder.refuse('declined');
    window.responder.send(RESULT);

    // Then the result was the only word after ready, and the window stays answered
    expect(getPostedTypes(opener)).toEqual(['dotli:s:ready', 'dotli:s:result']);
    expect(window.responder.state()).toEqual({ kind: 'answered' });
  });

  it.each<{ name: string; end: (window: ReturnType<typeof openWindow>) => void }>([
    {
      name: 'refused',
      end(window) {
        window.responder.refuse('declined');
      },
    },
    {
      name: 'cancelled',
      end(window) {
        window.responder.cancel();
      },
    },
  ])('As a site whose round was $name, I stay on it and hear nothing more whatever the window is asked', ({ end }) => {
    // Given a window vetted for a site whose round ended
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
    end(window);
    const posted = opener.posted.length;

    // When the round is sent, refused and cancelled
    window.responder.send(RESULT);
    window.responder.refuse('bad_request');
    window.responder.cancel();

    // Then nothing more went out
    expect(opener.posted).toHaveLength(posted);
  });

  it('As a site whose session window was restored, I am refused before I say hello again and still hear the refusal', () => {
    // Given a window vetted for a site, restored from the back-forward cache
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
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

  it('As a site opening the sign-out window, I say hello after its read and a refusal is all I hear', () => {
    // Given a sign-out window that read before its opener said hello
    const window = openWindow<typeof SIGNED_OUT_RESULT>();
    const opener = must(window.opener, 'an opener');
    window.responder.send(SIGNED_OUT_RESULT);

    // When a site says hello and the round is refused
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
    const vetted = window.responder.state();
    window.responder.refuse('bad_request');

    // Then the vetting sent nothing, and only the refusal went out
    expect(vetted).toEqual({ kind: 'vetted', origin: SITE, party: 'third' });
    expect(opener.posted.slice(1)).toEqual([
      { message: { type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }, target: SITE },
    ]);
  });

  it('As a site opening the sign-out window, I vet it again after a restore and its read from before the first vetting never reaches me', () => {
    // Given a sign-out window that read before a site vetted it, restored from the back-forward cache
    const window = openWindow<typeof SIGNED_OUT_RESULT>();
    const opener = must(window.opener, 'an opener');
    window.responder.send(SIGNED_OUT_RESULT);
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
    window.restorePage();

    // When the site says hello again
    window.post({ data: createHello('r1'), origin: SITE, source: opener });

    // Then it is vetted again and heard only ready twice
    expect(window.responder.state()).toEqual({ kind: 'vetted', origin: SITE, party: 'third' });
    expect(opener.posted.map(posted => posted.message)).toEqual([READY, READY]);
  });

  it("As a user in a restored sign-in window whose opener moved to another site, I see the new origin's hello ignored and my result kept for the first page", () => {
    // Given a window vetted for a dotli page, restored from the back-forward cache with its result finished
    const window = openWindow();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });
    window.restorePage();
    window.responder.send(RESULT);

    // When the opener, now on another site, says hello, and then the first page says hello again
    window.post({ data: createHello('r1'), origin: OTHER_SITE, source: opener });
    const afterOther = { state: window.responder.state(), posted: opener.posted.length };
    window.post({ data: createHello('r1'), origin: PAGE, source: opener });

    // Then the other site changed nothing and was not refused, and the result went to the first page alone
    expect(afterOther).toEqual({ state: { kind: 'connecting' }, posted: 2 });
    expect(window.metrics.counted('session_window.refused')).toEqual([]);
    expect(opener.posted.slice(2)).toEqual([
      { message: { type: 'dotli:s:result', round: 'r1', result: RESULT }, target: PAGE },
    ]);
  });

  it('As a site, I send my payload to the sign window after the vetting and it keeps my call until it is asked for', async () => {
    // Given a window vetted for a site
    const window = openWindow<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });

    // When the site sends its payload, and only then is the call asked for
    window.post({ data: createPayload('r1', '0x0a03'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then the call is the payload's, and nothing was said back
    expect(call).toBe('0x0a03');
    expect(opener.posted).toEqual([{ message: READY, target: '*' }]);
  });

  it.each<{ name: string; stage: (window: ReturnType<typeof openWindow<unknown>>, opener: FakeWindowHandle) => void }>([
    {
      name: 'before the vetting',
      stage(window, opener) {
        window.post({ data: createPayload('r1', '0xdead'), origin: SITE, source: opener });
        window.post({ data: createHello('r1'), origin: SITE, source: opener });
      },
    },
    {
      name: 'from another origin',
      stage(window, opener) {
        window.post({ data: createHello('r1'), origin: SITE, source: opener });
        window.post({ data: createPayload('r1', '0xdead'), origin: OTHER_SITE, source: opener });
      },
    },
    {
      name: 'from another window',
      stage(window, opener) {
        window.post({ data: createHello('r1'), origin: SITE, source: opener });
        window.post({ data: createPayload('r1', '0xdead'), origin: SITE, source: createFakeWindowHandle() });
      },
    },
    {
      name: 'for another round',
      stage(window, opener) {
        window.post({ data: createHello('r1'), origin: SITE, source: opener });
        window.post({ data: createPayload('r2', '0xdead'), origin: SITE, source: opener });
      },
    },
    {
      name: 'whose call is not a string',
      stage(window, opener) {
        window.post({ data: createHello('r1'), origin: SITE, source: opener });
        window.post({ data: createPayload('r1', 7), origin: SITE, source: opener });
      },
    },
  ])(
    'As a site, I send a payload $name and the sign window ignores it and keeps the first one that counts',
    async ({ stage }) => {
      // Given a window and a payload it must ignore
      const window = openWindow<unknown>();
      const opener = must(window.opener, 'an opener');
      stage(window, opener);

      // When the vetted site sends its payload
      window.post({ data: createPayload('r1', '0x0a03'), origin: SITE, source: opener });
      const call = await window.responder.payload();

      // Then the call is the one that counts
      expect(call).toBe('0x0a03');
    },
  );

  it('As a site, I send a second payload and the sign window keeps the first', async () => {
    // Given a window vetted for a site that sent its payload
    const window = openWindow<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
    window.post({ data: createPayload('r1', '0x0a03'), origin: SITE, source: opener });

    // When the site sends another
    window.post({ data: createPayload('r1', '0xdead'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then the first one counts
    expect(call).toBe('0x0a03');
  });

  it('As a site whose sign window was restored from the back-forward cache, I send my payload again after the new ready and the window keeps the first', async () => {
    // Given a window vetted for a site that sent its payload, restored and vetted again
    const window = openWindow<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
    window.post({ data: createPayload('r1', '0x0a03'), origin: SITE, source: opener });
    window.restorePage();
    window.post({ data: createHello('r1'), origin: SITE, source: opener });

    // When the site answers the new ready with its payload again, now another call
    window.post({ data: createPayload('r1', '0xdead'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then the first one counts, and the window is vetted again
    expect(call).toBe('0x0a03');
    expect(window.responder.state()).toEqual({ kind: 'vetted', origin: SITE, party: 'third' });
  });

  it('As a site whose sign window was restored before my payload came, I send it before my new hello and it counts', async () => {
    // Given a window vetted for a site, restored before any payload and waiting to be vetted again
    const window = openWindow<unknown>();
    const opener = must(window.opener, 'an opener');
    window.post({ data: createHello('r1'), origin: SITE, source: opener });
    window.restorePage();

    // When the site sends its payload before its new hello
    window.post({ data: createPayload('r1', '0x0a03'), origin: SITE, source: opener });
    const call = await window.responder.payload();

    // Then it counts, since the window was vetted once
    expect(call).toBe('0x0a03');
  });
});
