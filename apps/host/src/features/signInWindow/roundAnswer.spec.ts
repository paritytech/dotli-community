// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred, isRecord } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createFakeMessageBus, createFakeWindowHandle } from './listenToMessages.fake.js';
import { createFakePageEvents } from '../../testing/pageEvents.js';
import { getOpenerParty } from './openerRule.js';
import { createResponder } from './createResponder.js';
import { readSessionRequest, type SessionRequest } from './readSessionRequest.js';
import { answerSignIn, answerSignOut, SIGNED_OUT_RESULT } from './roundAnswer.js';
import { createHelloMessage } from './sessionMessages.js';
import type { SessionRoute } from './sessionRoute.js';

type Params = {
  /** Whether a page opened the window, false for a window with no opener. */
  opened?: boolean;
};

const SELF = 'https://dot.li';
const PAGE = 'https://browse.dot.li';
const SITE = 'https://example.com';
const ENABLED: readonly Network[] = ['paseo-next-v2'];
const HUB = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].assethub.genesis;
const CALL = '0x0a0300';
const PRODUCT = `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].dotns.TLD}`;

/** The request for round r1 on `route` with `params`, as the window reads it. */
function readRequest(route: SessionRoute, params: Record<string, unknown>): SessionRequest {
  return must(readSessionRequest(route, { round: 'r1', ...params }), 'a session request');
}

/**
 * A window's real responder over a fake opener, which says hello from `origin` when asked, or over no opener when
 * `opened` is false.
 */
function openWindow({ opened = true }: Params = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const opener = opened ? createFakeWindowHandle() : null;
  const messages = createFakeMessageBus();
  const responder = createResponder<unknown>({
    opener,
    judge: origin => getOpenerParty(origin, SELF),
    round: 'r1',
    listen: messages.listen,
    onPageRestore: createFakePageEvents().subscribe,
  });

  /** The opener saying hello for the round from `origin`. */
  function sayHello(origin: string): void {
    messages.post({ data: createHelloMessage('r1'), origin, source: opener });
  }

  /** What the opener got after its ready. */
  function readAnswers(): unknown[] {
    return (opener?.posted ?? []).flatMap(({ message }) =>
      isRecord(message) && message['type'] === 'dotli:s:ready' ? [] : [message],
    );
  }

  return { metrics, responder, sayHello, readAnswers };
}

describe('session window round answer', () => {
  it('As a user signing out on a dot.li page on a network this deployment does not run, I get only the refusal and no read', async () => {
    // Given a sign-out window on a network this deployment does not run, whose read is already made
    const { responder, sayHello, readAnswers } = openWindow();
    const read = createDeferred<undefined>();
    read.resolve(undefined);
    const { answered } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'previewnet' }),
      enabled: ENABLED,
      read: read.promise,
    });

    // When dot.li's own page says hello
    sayHello(PAGE);
    await answered;

    // Then the page gets the refusal alone
    expect(readAnswers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'unknown_network' }]);
  });

  it('As a user signing out on a dot.li page, I sign out with the read made before the vetting and get the read once', async () => {
    // Given a sign-out window whose read is made before any hello
    const { responder, sayHello, readAnswers } = openWindow();
    const read = createDeferred<undefined>();
    const { answered } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: read.promise,
    });
    read.resolve(undefined);

    // When dot.li's own page says hello
    sayHello(PAGE);
    await answered;

    // Then the page gets one empty result
    expect(readAnswers()).toEqual([{ type: 'dotli:s:result', round: 'r1', result: SIGNED_OUT_RESULT }]);
  });

  it('As a user signing out on a dot.li page, I sign out with the vetting before the read and get the read once', async () => {
    // Given a sign-out window vetted by dot.li's own page before its read is made
    const { responder, sayHello, readAnswers } = openWindow();
    const read = createDeferred<undefined>();
    const { answered } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: read.promise,
    });
    sayHello(PAGE);

    // When the read is made
    read.resolve(undefined);
    await answered;

    // Then the page gets one empty result
    expect(readAnswers()).toEqual([{ type: 'dotli:s:result', round: 'r1', result: SIGNED_OUT_RESULT }]);
  });

  it('As a user signing out on a dot.li page, I am released with the empty result when the window failed to boot and never read', async () => {
    // Given a sign-out window vetted by dot.li's own page, whose sign-out has not read yet
    const { responder, sayHello, readAnswers } = openWindow();
    const signedOut = createDeferred<undefined>();
    const { answered } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: signedOut.promise,
    });
    sayHello(PAGE);

    // When its boot fails before it read
    signedOut.reject(new Error('boot failed'));
    await answered;

    // Then the page gets one empty result and need not wait for the window to close
    expect(readAnswers()).toEqual([{ type: 'dotli:s:result', round: 'r1', result: SIGNED_OUT_RESULT }]);
  });

  it('As a site opening the sign-out window, I get a bad request refusal and no read, counted as my sign-in', async () => {
    // Given a sign-out window whose read is already made
    const { metrics, responder, sayHello, readAnswers } = openWindow();
    const read = createDeferred<undefined>();
    read.resolve(undefined);
    const { answered } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: read.promise,
    });

    // When a site says hello
    sayHello(SITE);
    await answered;

    // Then the site gets the refusal alone, counted as a refused site sign-in
    expect(readAnswers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
  });

  it("As a user signing out on a dot.li page, I open the sign-out window and it takes the round for dot.li's own", async () => {
    // Given a sign-out window whose read is not made yet
    const { responder, sayHello } = openWindow();
    const { firstParty } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: createDeferred<undefined>().promise,
    });

    // When dot.li's own page says hello
    sayHello(PAGE);

    // Then the round is dot.li's own, before any read
    expect(await firstParty).toBe(true);
  });

  it("As a site, I open the sign-out window and am never taken for dot.li's own page", async () => {
    // Given a sign-out window whose read is already made
    const { responder, sayHello } = openWindow();
    const { firstParty } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // When a site says hello
    sayHello(SITE);

    // Then the round is not dot.li's own
    expect(await firstParty).toBe(false);
  });

  it("As a user signing out on a dot.li page whose round the window refuses, I open the window and the round is not taken for dot.li's own", async () => {
    // Given a sign-out window on a network this deployment does not run
    const { responder, sayHello } = openWindow();
    const { firstParty } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'previewnet' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // When dot.li's own page says hello
    sayHello(PAGE);

    // Then the refused round is not dot.li's own
    expect(await firstParty).toBe(false);
  });

  it('As a product developer whose app opens the sign-out window, I am refused and the round is not taken for a page of dot.li', async () => {
    // Given a sign-out window whose read is already made
    const { responder, sayHello, readAnswers } = openWindow();
    const { firstParty } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // When a product says hello, which the opener rule refuses
    sayHello('https://app.dot.li');

    // Then the product is refused and the round is not dot.li's own
    expect(await firstParty).toBe(false);
    expect(readAnswers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'origin_not_allowed' }]);
  });

  it('As a user who opened the sign-out window by a link, I sign out with no page behind it and the round is no page of dot.li', async () => {
    // Given a sign-out window no page opened
    const { responder } = openWindow({ opened: false });

    // When it answers its round
    const { firstParty, answered } = answerSignOut({
      responder,
      request: readRequest('signout', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      read: Promise.resolve(),
    });

    // Then the round is no page's of dot.li and nothing is left to answer
    expect(await firstParty).toBe(false);
    await expect(answered).resolves.toBeUndefined();
  });

  it('As a user signing in on a dot.li page, I open the sign-in window and it runs the flow for my intent once it booted', async () => {
    // Given a sign-in window whose boot is still running
    const { responder, sayHello, readAnswers } = openWindow();
    const boot = createDeferred<string>();
    const answered = answerSignIn({
      responder,
      request: readRequest('auth', { v: 1, net: 'paseo-next-v2', intent: 'phrase' }),
      enabled: ENABLED,
      booted: boot.promise,
    });
    sayHello(PAGE);

    // When the boot ends
    boot.resolve('bridge');
    const round = await answered;

    // Then the window runs the flow for the request's intent on what the boot gave, and nothing was posted yet
    expect(round).toEqual({ party: 'first', intent: 'phrase', booted: 'bridge' });
    expect(readAnswers()).toEqual([]);
  });

  it('As a site, I open the sign-in window and get my sign-in round for the origin I said hello from, once it booted', async () => {
    // Given a sign-in window whose boot is still running, with a site's request that names another origin
    const { metrics, responder, sayHello, readAnswers } = openWindow();
    const boot = createDeferred<string>();
    const answered = answerSignIn({
      responder,
      request: readRequest('auth', { v: 1, net: 'paseo-next-v2', origin: 'https://other.example' }),
      enabled: ENABLED,
      booted: boot.promise,
    });
    sayHello(SITE);

    // When the boot ends
    boot.resolve('bridge');
    const round = await answered;

    // Then the window runs the site's sign-in for the vetted origin, and nothing was posted or counted yet
    expect(round).toEqual({
      party: 'third',
      origin: SITE,
      request: { round: 'r1', siteToken: null, groupToken: null },
      booted: 'bridge',
    });
    expect(readAnswers()).toEqual([]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([]);
  });

  it('As a site, I open the sign-in window with a request it cannot read and am refused as a bad request, counted', async () => {
    // Given a booted sign-in window with a site's request whose site token is malformed
    const { metrics, responder, sayHello, readAnswers } = openWindow();
    const answered = answerSignIn({
      responder,
      request: readRequest('auth', { v: 1, net: 'paseo-next-v2', site_token: 'not-a-token' }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When a site says hello
    sayHello(SITE);
    const round = await answered;

    // Then the site is refused, no flow runs and the refusal is counted as a site sign-in
    expect(round).toBeNull();
    expect(readAnswers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
  });

  it('As a user signing in on a dot.li page with a request the window cannot read, I am refused and no site sign-in is counted', async () => {
    // Given a booted sign-in window with a request that has no intent
    const { metrics, responder, sayHello, readAnswers } = openWindow();
    const answered = answerSignIn({
      responder,
      request: readRequest('auth', { v: 1, net: 'paseo-next-v2' }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When dot.li's own page says hello
    sayHello(PAGE);
    const round = await answered;

    // Then the page is refused as a bad request, with no site sign-in counted
    expect(round).toBeNull();
    expect(readAnswers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([]);
  });

  it('As a site, I open the sign window and get my transaction round for the origin I said hello from, once it booted', async () => {
    // Given a sign window whose boot is still running, with a site's request that names another origin
    const { metrics, responder, sayHello, readAnswers } = openWindow();
    const boot = createDeferred<string>();
    const answered = answerSignIn({
      responder,
      request: readRequest('sign', {
        v: 1,
        net: 'paseo-next-v2',
        chain: HUB,
        call: CALL,
        account: `${PRODUCT}/0`,
        origin: 'https://other.example',
      }),
      enabled: ENABLED,
      booted: boot.promise,
    });
    sayHello(SITE);

    // When the boot ends
    boot.resolve('bridge');
    const round = await answered;

    // Then the window runs the site's transaction for the vetted origin, and nothing was posted or counted yet
    expect(round).toEqual({
      party: 'third-sign',
      origin: SITE,
      request: {
        round: 'r1',
        account: { dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Index', value: 0 } },
        siteToken: null,
        groupToken: null,
        chain: HUB,
        call: CALL,
      },
      booted: 'bridge',
    });
    expect(readAnswers()).toEqual([]);
    expect(metrics.counted('session_pages.site_transaction')).toEqual([]);
  });

  it('As a site, I open the sign window with a request for another chain and am refused as a bad request, counted as my transaction', async () => {
    // Given a booted sign window with a site's request that names the relay chain
    const { metrics, responder, sayHello, readAnswers } = openWindow();
    const answered = answerSignIn({
      responder,
      request: readRequest('sign', {
        v: 1,
        net: 'paseo-next-v2',
        chain: NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].relay.genesis,
      }),
      enabled: ENABLED,
      booted: Promise.resolve('bridge'),
    });

    // When a site says hello
    sayHello(SITE);
    const round = await answered;

    // Then the site is refused, and the refusal counts as a transaction, not a sign-in
    expect(round).toBeNull();
    expect(readAnswers()).toEqual([{ type: 'dotli:s:refused', round: 'r1', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_transaction')).toEqual([{ outcome: 'refused', reason: 'bad_request' }]);
    expect(metrics.counted('session_pages.site_sign_in')).toEqual([]);
  });
});
