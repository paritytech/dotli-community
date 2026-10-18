// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { str } from 'scale-ts';
import { describe, expect, it, vi } from 'vitest';
import { manualTimers, must } from '@dotli/shared/testing';
import { TransportHandshakeTimeoutError, TransportVersionMismatchError } from './errors.js';
import { codec } from './codec.js';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { err, ok } from './result.js';
import { defineSchema } from './schema.js';
import {
  breakable,
  issueLog,
  notes,
  outcomeOf,
  rawRig,
  RETRY_MS,
  rig,
  testSchema,
  TIMEOUT_MS,
  VERSION,
} from './testing/rig.js';
import { createTransport } from './transport.js';

describe('the handshake', () => {
  it('As an opener whose hello does not encode, my handshake fails with why and my calls reject with it', async () => {
    // Given
    const refused = new RangeError('this hello does not encode');
    const hello = codec<string>(
      () => {
        throw refused;
      },
      () => '',
    );
    const schema = defineSchema({ version: VERSION, hello, traits: { notes: { touch: notes.touch } } });
    const transport = createTransport(schema, createProviderPair().left, {
      handshake: 'open',
      hello: 'opener',
      timers: manualTimers(),
    });
    const call = outcomeOf(transport.request(notes.touch, undefined));

    // When
    transport.connect();

    // Then
    expect(await outcomeOf(transport.whenConnected())).toBe(refused);
    expect(await call).toBe(refused);
  });

  it('As a peer, each side hears the other side once the opener connects, and the accepter needs no connect', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const opened = outcomeOf(opener.whenConnected());
    const accepted = outcomeOf(accepter.whenConnected());

    // When
    accepter.connect();
    opener.connect();
    opener.connect();
    await timers.advance(0);

    // Then
    expect(await opened).toEqual({ value: undefined });
    expect(await accepted).toEqual({ value: undefined });
  });

  it('As an opener, my handshake times out only on the running clock and survives a garbage answer', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('open');
    transport.connect();
    let settled: unknown;
    void outcomeOf(transport.whenConnected()).then(outcome => {
      settled = outcome;
    });

    // When
    peer.sendBytes(0xff, 0xff, 0xff);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'malformed',
        cause: expect.any(RangeError) as RangeError,
      },
    ]);
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS);
    expect(peer.heard.length).toBeGreaterThan(heard);

    // When
    timers.freeze(TIMEOUT_MS * 4);
    await timers.advance(TIMEOUT_MS - RETRY_MS);

    // Then
    expect(settled).toBeUndefined();

    // When
    await timers.advance(TIMEOUT_MS);

    // Then
    expect(settled).toBeInstanceOf(TransportHandshakeTimeoutError);
  });

  it('As an opener, a handshake answer after my handshake timed out changes nothing', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    const call = outcomeOf(transport.request(notes.touch, undefined));
    transport.connect();
    await timers.advance(TIMEOUT_MS);
    const timedOut = await outcomeOf(transport.whenConnected());
    expect(timedOut).toBeInstanceOf(TransportHandshakeTimeoutError);
    const heard = peer.heard.length;

    // When
    answerHandshake();
    await timers.advance(RETRY_MS * 10);

    // Then
    expect(await outcomeOf(transport.whenConnected())).toBe(timedOut);
    expect(await call).toBe(timedOut);
    expect(await outcomeOf(transport.request(notes.touch, undefined))).toBe(timedOut);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As an opener, a peer of another version fails my handshake at once with both versions', async () => {
    // Given
    const { transport, timers, peer } = rawRig('open');
    transport.connect();
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(0);
    const attempt = must(peer.heard[0], 'a handshake');

    // When
    peer.send(attempt.id, { tag: 'accept', value: err({ version: VERSION + 1 }) });
    await timers.advance(0);

    // Then
    const failure = await outcomeOf(transport.whenConnected());
    expect(failure).toBeInstanceOf(TransportVersionMismatchError);
    expect(failure).toMatchObject({ ours: VERSION, theirs: VERSION + 1 });
    expect(await call).toBe(failure);
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS * 10);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As an opener, every retry and flush posts a fresh buffer', async () => {
    // Given
    const { transport, timers, peer, left, answerHandshake } = rawRig('open');
    const post = vi.spyOn(left, 'post');
    const calls = [1, 2, 3].map(() => outcomeOf(transport.request(notes.touch, undefined)));

    // When
    transport.connect();
    await timers.advance(RETRY_MS * 3);
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(peer.names()).toEqual([
      'open',
      'open',
      'open',
      'open',
      'request:notes.touch',
      'request:notes.touch',
      'request:notes.touch',
    ]);
    expect(post.mock.results.every(result => result.type === 'return')).toBe(true);
    const done = new Error('done');
    transport.dispose(done);
    expect(await Promise.all(calls)).toEqual([done, done, done]);
  });

  it('As an opener, a provider that cannot post fails my handshake at once with why and reports the post', async () => {
    // Given
    const { left } = createProviderPair();
    const broken = new Error('port closed');
    const provider: Provider = {
      ...left,
      post: () => {
        throw broken;
      },
    };
    const timers = manualTimers();
    const { issues, onIssue } = issueLog();
    const transport = createTransport(testSchema, provider, { handshake: 'open', hello: 'opener', timers, onIssue });

    // When
    transport.connect();
    const outcome = outcomeOf(transport.whenConnected());
    await timers.advance(0);

    // Then
    expect(await outcome).toMatchObject({ cause: broken });
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
  });

  it('As an accepter, I answer every handshake attempt with the outcome of the first', async () => {
    // Given
    const { transport, timers, peer, openHandshake } = rawRig('accept');

    // When
    openHandshake(VERSION, 1);
    openHandshake(VERSION, 3);
    await timers.advance(0);

    // Then
    expect(peer.accepts()).toEqual([
      { id: 1, value: ok(str.enc('accepter')) },
      { id: 3, value: ok(str.enc('accepter')) },
    ]);
    await expect(transport.whenConnected()).resolves.toBeUndefined();
  });

  it('As an accepter, I refuse every attempt of another version and close with both versions', async () => {
    // Given
    const { transport, timers, peer, openHandshake } = rawRig('accept');
    const call = outcomeOf(transport.request(notes.touch, undefined));

    // When
    openHandshake(VERSION + 1, 1);
    openHandshake(VERSION + 1, 3);
    await timers.advance(0);

    // Then
    expect(peer.accepts()).toEqual([
      { id: 1, value: err({ version: VERSION }) },
      { id: 3, value: err({ version: VERSION }) },
    ]);
    const failure = await outcomeOf(transport.whenConnected());
    expect(failure).toBeInstanceOf(TransportVersionMismatchError);
    expect(failure).toMatchObject({ ours: VERSION, theirs: VERSION + 1 });
    expect(await call).toBe(failure);
    expect(peer.names()).not.toContain('request:notes.touch');
  });

  it('As an opener, a handshake answer before I connect is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('open');
    let connected = false;
    void transport.whenConnected().then(() => {
      connected = true;
    });

    // When
    peer.send(1, { tag: 'accept', value: ok(str.enc('peer')) });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(connected).toBe(false);
  });

  it('As an accepter, an answer I cannot post leaves me unconnected and the next attempt is answered afresh', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const { transport, timers, peer, issues, openHandshake } = rawRig('accept', wrap);
    void transport.request(notes.touch, undefined);
    let connected = false;
    void transport.whenConnected().then(() => {
      connected = true;
    });
    breakPosts();

    // When
    openHandshake(VERSION, 1);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
    expect(connected).toBe(false);

    // When
    mendPosts();
    openHandshake(VERSION, 3);
    await timers.advance(0);

    // Then
    expect(peer.accepts()).toEqual([{ id: 3, value: ok(str.enc('accepter')) }]);
    expect(connected).toBe(true);
    expect(peer.names()).toEqual(['accept', 'request:notes.touch']);
  });

  it('As either side, a handshake leg meant for the other side is refused as invalid', async () => {
    // Given
    const opening = rawRig('open');
    const accepting = rawRig('accept');

    // When
    opening.openHandshake();
    accepting.peer.send(1, { tag: 'accept', value: ok(str.enc('peer')) });
    await opening.timers.advance(0);

    // Then
    expect(opening.issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(accepting.issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(opening.peer.heard).toEqual([]);
    expect(accepting.peer.heard).toEqual([]);
  });
});
