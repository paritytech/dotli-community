// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createPendingReplies } from './pending-replies.js';

describe('createPendingReplies', () => {
  it('As a request channel, a reply settles the wait on its id and a second reply finds nothing', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const reply = replies.wait(1);

    // When
    const first = replies.resolve(1, 'block');
    const again = replies.resolve(1, 'block again');

    // Then
    await expect(reply).resolves.toBe('block');
    expect([first, again]).toEqual([true, false]);
    expect(replies.ids()).toEqual([]);
  });

  it('As a request channel that gave up on a request, its late reply settles nothing', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const reply = replies.wait(1);
    const timeout = new Error('no reply in time');

    // When
    replies.reject(1, timeout);
    const late = replies.resolve(1, 'block');

    // Then
    await expect(reply).rejects.toBe(timeout);
    expect(late).toBe(false);
  });

  it('As a channel that died, every wait still open fails with its own error and none is left', async () => {
    // Given
    const replies = createPendingReplies<string, string>();
    const a = replies.wait('a');
    const b = replies.wait('b');

    // When
    replies.rejectAll(id => new Error(`lost ${id}`));

    // Then
    await expect(a).rejects.toThrow('lost a');
    await expect(b).rejects.toThrow('lost b');
    expect(replies.ids()).toEqual([]);
  });

  it('As a channel reading progress, I read what a request left with its wait until it is answered', () => {
    // Given
    const replies = createPendingReplies<string, string, { method: string }>();
    void replies.wait('r1', { method: 'resolveDotName' });

    // When
    const during = replies.meta('r1');
    replies.resolve('r1', 'ok');

    // Then
    expect(during).toEqual({ method: 'resolveDotName' });
    expect(replies.meta('r1')).toBeUndefined();
  });

  it('As a channel that reused an id still waiting, I am told at once instead of losing the first wait', () => {
    // Given
    const replies = createPendingReplies<number, string>();
    void replies.wait(1);

    // When
    const reuse = (): Promise<string> => replies.wait(1);

    // Then
    expect(reuse).toThrow('already awaited');
    expect(replies.ids()).toEqual([1]);
  });
});
