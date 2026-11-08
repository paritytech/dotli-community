// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { must } from '@dotli/shared/testing';
import { encodeHeaderHex } from './testing/encodeHeaderHex.js';
import { openWatchFollow } from './openWatchFollow.js';

type Sent = {
  id: string;
  method: string;
  params: unknown[];
};

/** A follow over a session the test answers, and what it reported. */
function follow(
  options: {
    live?: () => boolean;
    onFollowing?: (value: boolean, handle: ReturnType<typeof openWatchFollow>) => void;
  } = {},
) {
  const sent: Sent[] = [];
  const following: boolean[] = [];
  let refused = 0;
  const best: number[] = [];
  let deliver: (message: unknown) => void = () => undefined;
  let disconnected = 0;
  const watch: Parameters<typeof openWatchFollow>[0] = {
    sessionId: 'watch:0',
    connect: onMessage => {
      deliver = onMessage;
      return {
        send: message => {
          // The follow sends only requests it built, with a string id and array params.
          sent.push(message as Sent);
        },
        disconnect: () => {
          disconnected += 1;
        },
      };
    },
    onFollowing: value => {
      following.push(value);
      options.onFollowing?.(value, handle);
    },
    onRefused: () => {
      refused += 1;
    },
    onBestBlock: value => best.push(value),
    live: options.live ?? (() => true),
  };
  const handle = openWatchFollow(watch);
  handle.start();

  function findLastSent(method: string): Sent {
    return must(sent.filter(message => message.method === method).at(-1), method);
  }

  return {
    handle,
    sent,
    following,
    best,
    countDisconnects: () => disconnected,
    countRefusals: () => refused,
    findLastSent,
    answer: (id: string, result: unknown) => {
      deliver({ jsonrpc: '2.0', id, result });
    },
    answerError: (id: string, error: { code: number; message: string }) => {
      deliver({ jsonrpc: '2.0', id, error });
    },
    emitEvent: (token: string, result: Record<string, unknown>) => {
      deliver({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: token, result } });
    },
  };
}

describe('openWatchFollow', () => {
  it('As the network panel, I hear each best block numbered from its header, and finalized blocks are unpinned', () => {
    // Given
    const watch = follow();
    watch.answer(watch.findLastSent('chainHead_v1_follow').id, 'tok');
    watch.emitEvent('tok', { event: 'initialized', finalizedBlockHashes: ['0xf0', '0xf1'] });

    // When
    watch.emitEvent('tok', { event: 'bestBlockChanged', bestBlockHash: '0xb1' });
    watch.answer(watch.findLastSent('chainHead_v1_header').id, encodeHeaderHex(8));
    watch.emitEvent('tok', { event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: ['0xdead'] });

    // Then
    expect(watch.following).toEqual([true]);
    expect(watch.best).toEqual([8]);
    expect(
      watch.sent.filter(message => message.method === 'chainHead_v1_unpin').map(message => message.params),
    ).toEqual([
      ['tok', ['0xf0']],
      ['tok', ['0xf1', '0xdead']],
    ]);
  });

  it('As the network panel, I have a follow the chain stops started again while the chain lives, and not once it closed', () => {
    // Given
    let live = true;
    const watch = follow({ live: () => live });
    watch.answer(watch.findLastSent('chainHead_v1_follow').id, 'tok');

    // When
    watch.emitEvent('tok', { event: 'stop' });
    const followsWhileLive = watch.sent.filter(message => message.method === 'chainHead_v1_follow').length;
    watch.answer(watch.findLastSent('chainHead_v1_follow').id, 'tok2');
    live = false;
    watch.emitEvent('tok2', { event: 'stop' });

    // Then
    expect(followsWhileLive).toBe(2);
    expect(watch.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(2);
    expect(watch.following).toEqual([true, false, true, false]);
  });

  it("As the network panel closing, I end my follow's session and start no other", () => {
    // Given
    const watch = follow();
    watch.answer(watch.findLastSent('chainHead_v1_follow').id, 'tok');

    // When
    watch.handle.disconnect();
    watch.emitEvent('tok', { event: 'stop' });

    // Then
    expect(watch.countDisconnects()).toBe(1);
    expect(watch.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(1);
  });

  it('As the network panel, my follow is refused and I hear it refused', () => {
    // Given
    const watch = follow();

    // When
    watch.answerError(watch.findLastSent('chainHead_v1_follow').id, { code: -32800, message: 'limit' });

    // Then
    expect(watch.countRefusals()).toBe(1);
    expect(watch.following).toEqual([]);
    expect(watch.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(1);
  });

  it('As the network panel, my follow the chain stops is refused again and I hear it refused', () => {
    // Given
    const watch = follow();
    watch.answer(watch.findLastSent('chainHead_v1_follow').id, 'tok');
    watch.emitEvent('tok', { event: 'stop' });

    // When
    watch.answerError(watch.findLastSent('chainHead_v1_follow').id, { code: -32800, message: 'limit' });

    // Then
    expect(watch.countRefusals()).toBe(1);
    expect(watch.following).toEqual([true, false]);
  });

  it("As the network panel closing while my follow's stop is reported, I start no other follow", () => {
    // Given
    const watch = follow({
      onFollowing: (value, handle) => {
        if (!value) {
          handle.disconnect();
        }
      },
    });
    watch.answer(watch.findLastSent('chainHead_v1_follow').id, 'tok');

    // When
    watch.emitEvent('tok', { event: 'stop' });

    // Then
    expect(watch.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(1);
  });
});
