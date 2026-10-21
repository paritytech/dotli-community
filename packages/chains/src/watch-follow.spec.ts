// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { must } from '@dotli/shared/testing';
import { headerHex } from './testing/header-hex.js';
import { openWatchFollow, type WatchFollowOptions } from './watch-follow.js';

interface Sent {
  id: string;
  method: string;
  params: unknown[];
}

/** A follow over a session the test answers, and what it reported. */
function follow(options: { live?: () => boolean } = {}) {
  const sent: Sent[] = [];
  const following: boolean[] = [];
  const best: number[] = [];
  let deliver: (message: unknown) => void = () => undefined;
  let disconnected = 0;
  const watch: WatchFollowOptions = {
    sessionId: 'watch:0',
    connect: onMessage => {
      deliver = onMessage;
      return {
        send: message => {
          sent.push(message as Sent);
        },
        disconnect: () => {
          disconnected += 1;
        },
      };
    },
    onFollowing: value => following.push(value),
    onBestBlock: value => best.push(value),
    live: options.live ?? (() => true),
  };
  const handle = openWatchFollow(watch);
  const lastOf = (method: string): Sent => must(sent.filter(message => message.method === method).at(-1), method);
  return {
    handle,
    sent,
    following,
    best,
    disconnected: () => disconnected,
    lastOf,
    answer: (id: string, result: unknown) => {
      deliver({ jsonrpc: '2.0', id, result });
    },
    event: (token: string, result: Record<string, unknown>) => {
      deliver({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: token, result } });
    },
  };
}

describe('openWatchFollow', () => {
  it('As the network panel, I hear each best block numbered from its header, and finalized blocks are unpinned', () => {
    // Given
    const watch = follow();
    watch.answer(watch.lastOf('chainHead_v1_follow').id, 'tok');
    watch.event('tok', { event: 'initialized', finalizedBlockHashes: ['0xf0', '0xf1'] });

    // When
    watch.event('tok', { event: 'bestBlockChanged', bestBlockHash: '0xb1' });
    watch.answer(watch.lastOf('chainHead_v1_header').id, headerHex(8));
    watch.event('tok', { event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: ['0xdead'] });

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

  it('As the network panel, a follow the chain stops starts again while the chain lives, and not once it closed', () => {
    // Given
    let live = true;
    const watch = follow({ live: () => live });
    watch.answer(watch.lastOf('chainHead_v1_follow').id, 'tok');

    // When
    watch.event('tok', { event: 'stop' });
    const followsWhileLive = watch.sent.filter(message => message.method === 'chainHead_v1_follow').length;
    watch.answer(watch.lastOf('chainHead_v1_follow').id, 'tok2');
    live = false;
    watch.event('tok2', { event: 'stop' });

    // Then
    expect(followsWhileLive).toBe(2);
    expect(watch.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(2);
    expect(watch.following).toEqual([true, false, true, false]);
  });

  it('As the network panel closing, my follow ends its session and starts no other', () => {
    // Given
    const watch = follow();
    watch.answer(watch.lastOf('chainHead_v1_follow').id, 'tok');

    // When
    watch.handle.disconnect();
    watch.event('tok', { event: 'stop' });

    // Then
    expect(watch.disconnected()).toBe(1);
    expect(watch.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(1);
  });
});
