// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { deferred } from '@dotli/shared';
import { describe, expect, it, onTestFinished } from 'vitest';
import { SIGNED_OUT_RESULT } from './messages.js';
import { createFakeMessageBus, createFakeWindowHandle } from './messages.fake.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import { openerParty } from './opener-rule.js';
import { createResponder } from './responder.js';
import { answerSignIn, answerSignOut } from './round-answer.js';
import type { SessionRequest, SessionRoute } from './session-protocol.js';

const SELF = 'https://dot.li';
const PAGE = 'https://browse.dot.li';
const SITE = 'https://example.com';
const ENABLED: readonly Network[] = ['paseo-next-v2'];
const HUB = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].assethub.genesis;
const CALL = '0x0a0300';

/** A request on `route` with `params` as the page sent them. */
function requestOf(route: SessionRoute, params: Record<string, unknown>): SessionRequest {
  const { v, net } = params;
  return {
    route,
    round: 'r1',
    v: typeof v === 'number' ? v : null,
    net: typeof net === 'string' ? net : null,
    params: { round: 'r1', ...params },
  };
}

/**
 * A window's real responder over a fake opener, which says hello from `origin` when asked, or over no opener when
 * `opened` is false.
 */
function harness({ opened = true }: { opened?: boolean } = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const opener = opened ? createFakeWindowHandle() : null;
  const messages = createFakeMessageBus();
  const responder = createResponder<unknown>({
    opener,
    judge: origin => openerParty(origin, SELF),
    round: 'r1',
    listen: messages.listen,
    onPageRestore: createFakePageEvents().subscribe,
  });
  return {
    metrics,
    responder,
    hello: (origin: string): void => {
      messages.post({ data: { type: 'dotli:s:hello', v: 1, round: 'r1' }, origin, source: opener });
    },
    /** What the opener got after its ready, by message type. */
    answers: () =>
      (opener?.posted ?? []).flatMap(({ message }) => {
        const { type } = message as { type: string };
        return type === 'dotli:s:ready' ? [] : [message];
      }),
  };
}

describe('session window round answer', () => {
  it('As a first-party page whose sign-out round the dispatch refuses, I get only the refusal and no read', async () => {
    // Given a sign-out window on a network this deployment does not run, whose read is already made
    const { responder, hello, answers } = harness();
    const read = deferred<undefined>();
    read.resolve(undefined);
    const { answered } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'previewnet' }),
      enabled: ENABLED,
      read: read.promise,
    });

    // When dot.li's own page says hello
    hello(PAGE);
    await answered;

    // Then the page gets the refusal alone
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'unknown_network' }]);
  });

  it('As a page signing out, I get the read once when the read comes before the vetting', async () => {
    // Given a sign-out window whose read is made before any hello
    const { responder, hello, answers } = harness();
    const read = deferred<undefined>();
    const { answered } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: read.promise,
    });
    read.resolve(undefined);

    // When dot.li's own page says hello
    hello(PAGE);
    await answered;

    // Then the page gets one empty result
    expect(answers()).toEqual([{ type: 'dotli:s:result', round: 'r1', result: SIGNED_OUT_RESULT }]);
  });

  it('As a page signing out, I get the read once when the vetting comes before the read', async () => {
    // Given a sign-out window vetted by dot.li's own page before its read is made
    const { responder, hello, answers } = harness();
    const read = deferred<undefined>();
    const { answered } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: read.promise,
    });
    hello(PAGE);

    // When the read is made
    read.resolve(undefined);
    await answered;

    // Then the page gets one empty result
    expect(answers()).toEqual([{ type: 'dotli:s:result', round: 'r1', result: SIGNED_OUT_RESULT }]);
  });

  it('As a page signing out, I am released with the empty result when the window failed to boot and never read', async () => {
    // Given a sign-out window vetted by dot.li's own page, whose sign-out has not read yet
    const { responder, hello, answers } = harness();
    const signedOut = deferred<undefined>();
    const { answered } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: signedOut.promise,
    });
    hello(PAGE);

    // When its boot fails before it read
    signedOut.reject(new Error('boot failed'));
    await answered;

    // Then the page gets one empty result and need not wait for the window to close
    expect(answers()).toEqual([{ type: 'dotli:s:result', round: 'r1', result: SIGNED_OUT_RESULT }]);
  });

  it('As a site opening the sign-out window, I get a bad request refusal and no read, counted as my sign-in', async () => {
    // Given a sign-out window whose read is already made
    const { metrics, responder, hello, answers } = harness();
    const read = deferred<undefined>();
    read.resolve(undefined);
    const { answered } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: read.promise,
    });

    // When a site says hello
    hello(SITE);
    await answered;

    // Then the site gets the refusal alone, counted as a refused site sign-in
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
  });

  it("As dot.li's own page signing out, I open the sign-out window and it takes the round for mine", async () => {
    // Given a sign-out window whose read is not made yet
    const { responder, hello } = harness();
    const { firstParty } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: deferred<undefined>().promise,
    });

    // When dot.li's own page says hello
    hello(PAGE);

    // Then the round is dot.li's own, before any read
    expect(await firstParty).toBe(true);
  });

  it("As a site opening the sign-out window, I am never taken for dot.li's own page", async () => {
    // Given a sign-out window whose read is already made
    const { responder, hello } = harness();
    const { firstParty } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // When a site says hello
    hello(SITE);

    // Then the round is not dot.li's own
    expect(await firstParty).toBe(false);
  });

  it("As dot.li's own page whose sign-out round the dispatch refuses, I do not have the round taken for mine", async () => {
    // Given a sign-out window on a network this deployment does not run
    const { responder, hello } = harness();
    const { firstParty } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'previewnet' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // When dot.li's own page says hello
    hello(PAGE);

    // Then the refused round is not dot.li's own
    expect(await firstParty).toBe(false);
  });

  it('As a product opening the sign-out window, I am refused and the round is not taken for a page of dot.li', async () => {
    // Given a sign-out window whose read is already made
    const { responder, hello, answers } = harness();
    const { firstParty } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // When a product says hello, which the opener rule refuses
    hello('https://app.dot.li');

    // Then the product is refused and the round is not dot.li's own
    expect(await firstParty).toBe(false);
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'origin_not_allowed' }]);
  });

  it('As a user who opened the sign-out window by a link, I sign out with no page behind it and the round is no page of dot.li', async () => {
    // Given a sign-out window no page opened
    const { responder } = harness({ opened: false });

    // When it answers its round
    const { firstParty, answered } = answerSignOut({
      responder,
      request: requestOf('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // Then the round is no page's of dot.li and nothing is left to answer
    expect(await firstParty).toBe(false);
    await expect(answered).resolves.toBeUndefined();
  });

  it("As dot.li's own page, I open the sign-in window and get its flow's intent once it booted", async () => {
    // Given a sign-in window whose boot is still running
    const { responder, hello, answers } = harness();
    const boot = deferred<string>();
    const answered = answerSignIn({
      responder,
      request: requestOf('auth', { v: 1, net: 'paseo-next-v2', intent: 'phrase' }),
      enabled: ENABLED,
      booted: boot.promise,
    });
    hello(PAGE);

    // When the boot ends
    boot.resolve('bridge');
    const round = await answered;

    // Then the window runs the flow for the request's intent on what the boot gave, and nothing was posted yet
    expect(round).toEqual({ party: 'first', intent: 'phrase', booted: 'bridge' });
    expect(answers()).toEqual([]);
  });

  it('As a site opening the sign-in window, I get my sign-in round for the origin I said hello from, once it booted', async () => {
    // Given a sign-in window whose boot is still running, with a site's request that names another origin
    const { metrics, responder, hello, answers } = harness();
    const boot = deferred<string>();
    const answered = answerSignIn({
      responder,
      request: requestOf('auth', { v: 1, net: 'paseo-next-v2', nonce: 'abcdefgh', origin: 'https://other.example' }),
      enabled: ENABLED,
      booted: boot.promise,
    });
    hello(SITE);

    // When the boot ends
    boot.resolve('bridge');
    const round = await answered;

    // Then the window runs the site's sign-in for the vetted origin, and nothing was posted or counted yet
    expect(round).toEqual({
      party: 'third',
      origin: SITE,
      request: { round: 'r1', nonce: 'abcdefgh', statement: null, siteToken: null, groupToken: null },
      net: 'paseo-next-v2',
      booted: 'bridge',
    });
    expect(answers()).toEqual([]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([]);
  });

  it('As a site opening the sign-in window with a request the window cannot read, I am refused as a bad request, counted', async () => {
    // Given a booted sign-in window with a site's request that has no nonce
    const { metrics, responder, hello, answers } = harness();
    const answered = answerSignIn({
      responder,
      request: requestOf('auth', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When a site says hello
    hello(SITE);
    const round = await answered;

    // Then the site is refused, no flow runs and the refusal is counted as a site sign-in
    expect(round).toBeNull();
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
  });

  it('As a site opening the sign-in window with a request of another version, I am refused with that reason, counted', async () => {
    // Given a booted sign-in window with a site's request of version 2
    const { metrics, responder, hello, answers } = harness();
    const answered = answerSignIn({
      responder,
      request: requestOf('auth', { v: 2, net: 'paseo-next-v2', nonce: 'abcdefgh' }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When a site says hello
    hello(SITE);
    await answered;

    // Then the site is refused for the version, and so counted
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'unsupported_version' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([
      { outcome: 'refused', reason: 'unsupported_version' },
    ]);
  });

  it("As dot.li's own page with a request the window cannot read, I am refused and no site sign-in is counted", async () => {
    // Given a booted sign-in window with a request that has no intent
    const { metrics, responder, hello, answers } = harness();
    const answered = answerSignIn({
      responder,
      request: requestOf('auth', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When dot.li's own page says hello
    hello(PAGE);
    const round = await answered;

    // Then the page is refused as a bad request, with no site sign-in counted
    expect(round).toBeNull();
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([]);
  });

  it('As a site opening the sign window, I get my transaction round for the origin I said hello from, once it booted', async () => {
    // Given a sign window whose boot is still running, with a site's request that names another origin
    const { metrics, responder, hello, answers } = harness();
    const boot = deferred<string>();
    const answered = answerSignIn({
      responder,
      request: requestOf('sign', {
        v: 1,
        net: 'paseo-next-v2',
        chain: HUB,
        call: CALL,
        origin: 'https://other.example',
      }),
      enabled: ENABLED,
      booted: boot.promise,
    });
    hello(SITE);

    // When the boot ends
    boot.resolve('bridge');
    const round = await answered;

    // Then the window runs the site's transaction for the vetted origin, and nothing was posted or counted yet
    expect(round).toEqual({
      party: 'third-sign',
      origin: SITE,
      request: { round: 'r1', siteToken: null, groupToken: null, chain: HUB, call: CALL },
      booted: 'bridge',
    });
    expect(answers()).toEqual([]);
    expect(metrics.counted('session_pages.site_transaction')).toEqual([]);
  });

  it('As a site opening the sign window with a request for another chain, I am refused as a bad request, counted as my transaction', async () => {
    // Given a booted sign window with a site's request that names the relay chain
    const { metrics, responder, hello, answers } = harness();
    const answered = answerSignIn({
      responder,
      request: requestOf('sign', {
        v: 1,
        net: 'paseo-next-v2',
        chain: NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].relay.genesis,
      }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When a site says hello
    hello(SITE);
    const round = await answered;

    // Then the site is refused, and the refusal counts as a transaction, not a sign-in
    expect(round).toBeNull();
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([]);
  });

  it("As dot.li's own page opening the sign window, I am refused as a bad request and no site round is counted", async () => {
    // Given a booted sign window with a request a site could send
    const { metrics, responder, hello, answers } = harness();
    const answered = answerSignIn({
      responder,
      request: requestOf('sign', { v: 1, net: 'paseo-next-v2', chain: HUB, call: CALL }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When dot.li's own page says hello
    hello(PAGE);
    const round = await answered;

    // Then the page is refused as a bad request, with no site round counted
    expect(round).toBeNull();
    expect(answers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_transaction')).toEqual([]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([]);
  });
});
