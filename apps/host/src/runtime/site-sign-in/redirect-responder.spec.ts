// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { deferred } from '@dotli/shared';
import { describe, expect, it } from 'vitest';
import { createRedirectResponder, type RedirectDelivery, type RedirectResponder } from './redirect-responder.js';

const ORIGIN = 'https://site.example';
const RETURN_TO = 'https://site.example/back';
const PUB = new Uint8Array(32).fill(5);
const ROUND = 'r1';
const SEALED = `${RETURN_TO}#dotli-s=sealed`;

interface SealCall {
  returnTo: string;
  pub: Uint8Array;
  round: string;
  message: unknown;
}

/**
 * A redirect responder whose seal answers with `sealed`, and which records each seal, the forgetting of the kept
 * request and each navigation, in the order they came.
 */
function redirectResponder(sealed: () => Promise<string> = () => Promise.resolve(SEALED)) {
  const seals: SealCall[] = [];
  const events: string[] = [];
  const navigated = deferred<string>();
  const failure = deferred<{ error: unknown; siteToken: string | undefined; delivery: RedirectDelivery }>();
  const responder = createRedirectResponder({
    origin: ORIGIN,
    returnTo: RETURN_TO,
    pub: PUB,
    round: ROUND,
    seal: (returnTo, pub, round, message) => {
      seals.push({ returnTo, pub, round, message });
      return sealed();
    },
    forgetRequest: () => {
      events.push('forget');
    },
    navigate: url => {
      events.push(`navigate ${url}`);
      navigated.resolve(url);
    },
    failed: (error, siteToken) => {
      events.push('failed');
      failure.resolve({ error, siteToken, delivery: responder.delivery() });
    },
  });
  return { responder, seals, events, navigated: navigated.promise, failure: failure.promise };
}

describe('redirect responder', () => {
  it('As a vetted site, I start a redirect round and the responder starts vetted as a third party for my origin', () => {
    // Given a vetted redirect
    // When its responder is made
    const { responder } = redirectResponder();

    // Then it starts vetted for the return address's origin, with no answer on its way
    expect(responder.state()).toEqual({ kind: 'vetted', origin: ORIGIN, party: 'third' });
    expect(responder.delivery()).toBe('none');
  });

  it.each<[string, (responder: RedirectResponder) => void]>([
    [
      'sends its result',
      responder => {
        responder.send({ account: 'a' });
      },
    ],
    [
      'refuses',
      responder => {
        responder.refuse('declined');
      },
    ],
    [
      'cancels',
      responder => {
        responder.cancel();
      },
    ],
  ])(
    'As a window whose round %s, I hold the answer as pending while it seals and as sent once I navigate',
    async (_name, end) => {
      // Given a redirect responder whose seal has not finished
      const seal = deferred<string>();
      const { responder, navigated } = redirectResponder(() => seal.promise);

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

  it('As a site, I get my result sealed to my key and the window forgets its request, then navigates once', async () => {
    // Given a redirect responder
    const { responder, seals, events, navigated } = redirectResponder();

    // When the round sends its result with a site token
    responder.send({ account: 'a' }, 'tok');

    // Then the state is answered at once, the result message is sealed, and the window navigates once after forgetting
    expect(responder.state()).toEqual({ kind: 'answered' });
    expect(seals).toEqual([
      {
        returnTo: RETURN_TO,
        pub: PUB,
        round: ROUND,
        message: { type: 'dotli:s:result', round: ROUND, result: { account: 'a' }, site_token: 'tok' },
      },
    ]);
    expect(await navigated).toBe(SEALED);
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
  });

  it('As a site, I get a result with no site token and the sealed message carries none', async () => {
    // Given a redirect responder
    const { responder, seals, navigated } = redirectResponder();

    // When the round sends its result without a token
    responder.send({ account: 'a' });

    // Then the sealed message has no site token
    await navigated;
    expect(seals.map(seal => seal.message)).toEqual([
      { type: 'dotli:s:result', round: ROUND, result: { account: 'a' } },
    ]);
  });

  it('As a site, I am refused and the refusal is sealed to my key before the window navigates once', async () => {
    // Given a redirect responder
    const { responder, seals, events, navigated } = redirectResponder();

    // When the round refuses the site
    responder.refuse('declined');

    // Then the state is refused at once and the refusal is sealed and sent by one navigation
    expect(responder.state()).toEqual({ kind: 'refused' });
    expect(seals.map(seal => seal.message)).toEqual([{ type: 'dotli:s:refused', round: ROUND, reason: 'declined' }]);
    await navigated;
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
  });

  it('As a site whose user left, I get the cancel sealed to my key and the window navigates once', async () => {
    // Given a redirect responder
    const { responder, seals, events, navigated } = redirectResponder();

    // When the round cancels
    responder.cancel();

    // Then the state is answered at once and the cancel is sealed and sent by one navigation
    expect(responder.state()).toEqual({ kind: 'answered' });
    expect(seals.map(seal => seal.message)).toEqual([{ type: 'dotli:s:cancelled', round: ROUND }]);
    await navigated;
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
  });

  it('As a site, I get one answer per round, and later calls neither seal nor navigate again', async () => {
    // Given a redirect responder that answered the round
    const { responder, seals, events, navigated } = redirectResponder();
    responder.send({ account: 'a' });
    await navigated;

    // When the round refuses, cancels and sends again
    responder.refuse('declined');
    responder.cancel();
    responder.send({ account: 'b' });

    // Then nothing more was sealed or sent, and the state stays answered
    expect(seals).toHaveLength(1);
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
    expect(responder.state()).toEqual({ kind: 'answered' });
  });

  it('As a user whose browser fails to seal, I am told the window failed and nothing is sent', async () => {
    // Given a seal that fails
    const error = new Error('seal failed');
    const { responder, events, failure } = redirectResponder(() => Promise.reject(error));

    // When the round sends its result with a site token
    responder.send({ account: 'a' }, 'tok');

    // Then the failure is handed on with the token the site never got once the delivery reads failed, nothing is
    // forgotten or navigated, and the state stays as set
    expect(await failure).toEqual({ error, siteToken: 'tok', delivery: 'failed' });
    expect(events).toEqual(['failed']);
    expect(responder.state()).toEqual({ kind: 'answered' });
    expect(responder.delivery()).toBe('failed');
  });

  it('As a user whose browser fails to seal a refusal, I am told the window failed with no site token', async () => {
    // Given a seal that fails
    const error = new Error('seal failed');
    const { responder, failure } = redirectResponder(() => Promise.reject(error));

    // When the round refuses the site
    responder.refuse('declined');

    // Then the failure is handed on with no token
    expect(await failure).toEqual({ error, siteToken: undefined, delivery: 'failed' });
  });

  it('As a user whose browser failed to seal, I get no second answer sealed when the round ends again', async () => {
    // Given a redirect responder whose seal failed
    const { responder, seals, failure } = redirectResponder(() => Promise.reject(new Error('seal failed')));
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

  it('As a site, I get one answer when the round ends again while the first answer is still sealing', async () => {
    // Given a redirect responder whose seal has not finished
    const seal = deferred<string>();
    const { responder, seals, events, navigated } = redirectResponder(() => seal.promise);
    responder.send({ account: 'a' });

    // When the round refuses, cancels and sends again, then the first seal finishes
    responder.refuse('declined');
    responder.cancel();
    responder.send({ account: 'b' });
    seal.resolve(SEALED);

    // Then only the first answer was sealed, and one navigation followed
    await navigated;
    expect(seals.map(call => call.message)).toEqual([
      { type: 'dotli:s:result', round: ROUND, result: { account: 'a' } },
    ]);
    expect(events).toEqual(['forget', `navigate ${SEALED}`]);
  });

  it('As a watcher of the round, I am told of the state each call sets', () => {
    // Given a redirect responder with a subscriber
    const { responder } = redirectResponder();
    const seen: string[] = [];
    responder.subscribe(state => {
      seen.push(state.kind);
    });

    // When the round refuses the site
    responder.refuse('declined');

    // Then the subscriber saw the refusal
    expect(seen).toEqual(['refused']);
  });
});
