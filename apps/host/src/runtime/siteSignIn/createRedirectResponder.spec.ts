// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createDeferred } from '@dotli/shared';
import { recordReports } from '@dotli/metrics/testing';
import { catchError } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ResponderState } from '../sessionHandoff/createResponder.js';
import { createRedirectResponder, type RedirectDelivery, type RedirectResponder } from './createRedirectResponder.js';
import type { sealRedirect } from './siteSeal.js';

type SealCall = Parameters<typeof sealRedirect>[0];

const ORIGIN = 'https://site.example';
const RETURN_TO = 'https://site.example/back';
const SITE_PUBLIC_KEY = new Uint8Array(32).fill(5);
const ROUND = 'r1';
const SEALED = `${RETURN_TO}#dotli-s=sealed`;

/**
 * A redirect responder whose seal answers with `sealed`, and which records each seal, the forgetting of the kept
 * request and each navigation, in the order they came.
 */
function openRedirectResponder(sealed: () => Promise<string> = () => Promise.resolve(SEALED)) {
  const seals: SealCall[] = [];
  const events: string[] = [];
  const navigated = createDeferred<string>();
  const failure = createDeferred<{ error: unknown; siteToken: string | undefined; delivery: RedirectDelivery }>();
  const responder = createRedirectResponder({
    origin: ORIGIN,
    returnTo: RETURN_TO,
    sitePublicKey: SITE_PUBLIC_KEY,
    round: ROUND,
    seal(call) {
      seals.push(call);
      return sealed();
    },
    forgetRequest() {
      events.push('forget');
    },
    navigate(url) {
      events.push(`navigate ${url}`);
      navigated.resolve(url);
    },
    failed(error, siteToken) {
      events.push('failed');
      failure.resolve({ error, siteToken, delivery: responder.delivery() });
    },
  });
  return { responder, seals, events, navigated: navigated.promise, failure: failure.promise };
}

describe('redirect responder', () => {
  it('As a vetted site, I start a redirect round and the responder starts vetted as a third party for my origin', () => {
    // Given a vetted redirect whose seal answers at once
    const sealed = () => Promise.resolve(SEALED);

    // When its responder is made
    const { responder } = openRedirectResponder(sealed);

    // Then it starts vetted for the return address's origin, with no answer on its way
    expect(responder.state.get()).toEqual({ kind: 'vetted', origin: ORIGIN, party: 'third' });
    expect(responder.delivery()).toBe('none');
  });

  it.each<{ name: string; end: (responder: RedirectResponder) => void }>([
    {
      name: 'sending its result',
      end(responder) {
        responder.send({ account: 'a' });
      },
    },
    {
      name: 'refusing',
      end(responder) {
        responder.refuse('declined');
      },
    },
    {
      name: 'cancelling',
      end(responder) {
        responder.cancel();
      },
    },
  ])(
    'As a user, I end a redirect round by $name and the answer is pending while it seals and sent once the window navigates',
    async ({ end }) => {
      // Given a redirect responder whose seal has not finished
      const seal = createDeferred<string>();
      const { responder, navigated } = openRedirectResponder(() => seal.promise);

      // When the round ends, then the seal finishes
      end(responder);
      const whileSealing = responder.delivery();
      seal.resolve(SEALED);
      await navigated;

      // Then the answer was pending while it sealed, and is sent once the window navigated
      expect(whileSealing).toBe('pending');
      expect(responder.delivery()).toBe('sent');
    },
  );

  it.each<{
    name: string;
    end: (responder: RedirectResponder) => void;
    state: ResponderState;
    message: unknown;
  }>([
    {
      name: 'my result with a site token',
      end(responder) {
        responder.send({ account: 'a' }, { siteToken: 'tok' });
      },
      state: { kind: 'answered' },
      message: { type: 'dotli:s:result', round: ROUND, result: { account: 'a' }, site_token: 'tok' },
    },
    {
      name: 'my result with no site token',
      end(responder) {
        responder.send({ account: 'a' });
      },
      state: { kind: 'answered' },
      message: { type: 'dotli:s:result', round: ROUND, result: { account: 'a' } },
    },
    {
      name: 'a refusal',
      end(responder) {
        responder.refuse('declined');
      },
      state: { kind: 'refused' },
      message: { type: 'dotli:s:refused', round: ROUND, reason: 'declined' },
    },
    {
      name: 'the cancel of a user who left',
      end(responder) {
        responder.cancel();
      },
      state: { kind: 'answered' },
      message: { type: 'dotli:s:cancelled', round: ROUND },
    },
  ])(
    'As a site, I get $name sealed to my key and the window forgets its request, then navigates once',
    async ({ end, state, message }) => {
      // Given a redirect responder
      const { responder, seals, events, navigated } = openRedirectResponder();

      // When the round ends, and the window navigates
      end(responder);
      const stateAtOnce = responder.state.get();
      const url = await navigated;

      // Then the state was set at once, the message is sealed, and the window navigates once after forgetting
      expect(stateAtOnce).toEqual(state);
      expect(seals).toEqual([{ returnTo: RETURN_TO, sitePublicKey: SITE_PUBLIC_KEY, round: ROUND, message }]);
      expect(url).toBe(SEALED);
      expect(events).toEqual(['forget', `navigate ${SEALED}`]);
    },
  );

  it('As a site, I get one answer per round, and later calls neither seal nor navigate again', async () => {
    // Given a redirect responder that answered the round
    const { responder, seals, events, navigated } = openRedirectResponder();
    responder.send({ account: 'a' });
    await navigated;

    // When the round refuses, cancels and sends again
    responder.refuse('declined');
    responder.cancel();
    responder.send({ account: 'b' });

    // Then nothing more was sealed or sent, and the state stays answered
    expect(seals).toHaveLength(1);
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
    expect(responder.state.get()).toEqual({ kind: 'answered' });
  });

  it('As a user whose browser fails to seal, I am told the window failed and nothing is sent', async () => {
    // Given a seal that fails
    const error = new Error('seal failed');
    const { responder, events, failure } = openRedirectResponder(() => Promise.reject(error));

    // When the round sends its result with a site token
    responder.send({ account: 'a' }, { siteToken: 'tok' });
    const failed = await failure;

    // Then the failure is handed on with the token the site never got once the delivery reads failed, nothing is
    // forgotten or navigated, and the state stays as set
    expect(failed).toEqual({ error, siteToken: 'tok', delivery: 'failed' });
    expect(events).toEqual(['failed']);
    expect(responder.state.get()).toEqual({ kind: 'answered' });
    expect(responder.delivery()).toBe('failed');
  });

  it('As a user whose browser fails to seal a refusal, I see the window fail and no site token is handed on', async () => {
    // Given a seal that fails
    const error = new Error('seal failed');
    const { responder, failure } = openRedirectResponder(() => Promise.reject(error));

    // When the round refuses the site
    responder.refuse('declined');
    const failed = await failure;

    // Then the failure is handed on with no token
    expect(failed).toEqual({ error, siteToken: undefined, delivery: 'failed' });
  });

  it('As a user whose browser failed to seal, I end the round again and no second answer is sealed', async () => {
    // Given a redirect responder whose seal failed
    const { responder, seals, failure } = openRedirectResponder(() => Promise.reject(new Error('seal failed')));
    responder.send({ account: 'a' });
    await failure;

    // When the round refuses, cancels and sends again
    responder.refuse('declined');
    responder.cancel();
    responder.send({ account: 'b' });

    // Then nothing more was sealed and the delivery stays failed
    expect(seals).toHaveLength(1);
    expect(responder.delivery()).toBe('failed');
  });

  it('As a site whose round ends again while the first answer is still sealing, I wait for my answer and get only the first', async () => {
    // Given a redirect responder whose seal has not finished
    const seal = createDeferred<string>();
    const { responder, seals, events, navigated } = openRedirectResponder(() => seal.promise);
    responder.send({ account: 'a' });

    // When the round refuses, cancels and sends again, then the first seal finishes
    responder.refuse('declined');
    responder.cancel();
    responder.send({ account: 'b' });
    seal.resolve(SEALED);
    await navigated;

    // Then only the first answer was sealed, and one navigation followed
    expect(seals.map(call => call.message)).toEqual([
      { type: 'dotli:s:result', round: ROUND, result: { account: 'a' } },
    ]);
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
  });

  it('As a site whose answer is still sealing when the responder is disposed, I still get that answer', async () => {
    // Given a redirect responder whose seal has not finished
    const seal = createDeferred<string>();
    const { responder, events, navigated } = openRedirectResponder(() => seal.promise);
    responder.send({ account: 'a' });

    // When it is disposed and the seal then finishes
    responder.dispose();
    seal.resolve(SEALED);
    await navigated;

    // Then the window forgot its request and navigated with the answer
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
    expect(responder.delivery()).toBe('sent');
  });

  it('As a dotli integrator, I dispose a redirect responder twice and see no error', () => {
    // Given a redirect responder disposed once
    const { responder } = openRedirectResponder();
    responder.dispose();

    // When it is disposed again
    const thrown = catchError(() => {
      responder.dispose();
    });

    // Then nothing threw
    expect(thrown).toBeUndefined();
  });

  it('As an operator, I see a redirect responder whose navigation throws reported as a defect', async () => {
    // Given a responder whose navigation throws, once its seal resolves
    const reports = recordReports({ onFinished: onTestFinished });
    const sealed = createDeferred<string>();
    const navigating = createDeferred<undefined>();
    const responder = createRedirectResponder({
      origin: ORIGIN,
      returnTo: RETURN_TO,
      sitePublicKey: SITE_PUBLIC_KEY,
      round: ROUND,
      seal: () => sealed.promise,
      forgetRequest: () => undefined,
      navigate() {
        navigating.resolve(undefined);
        throw new Error('navigate failed');
      },
      failed: () => undefined,
    });

    // When it sends a result and the seal resolves
    responder.send({ account: 'a' });
    sealed.resolve(SEALED);
    await navigating.promise;

    // Then the throw is reported as a defect and the delivery is sent
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(responder.delivery()).toBe('sent');
  });
});
