// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createPendingReplies } from './createPendingReplies.js';
import { catchError } from './testing/catchError.js';

describe('createPendingReplies', () => {
  it('As a request channel, I pass a reply and it settles the wait on its id, while a second reply finds nothing', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const reply = replies.wait(1);

    // When
    replies.resolve(1, 'block');
    replies.resolve(1, 'block again');
    const next = replies.wait(1);
    replies.resolve(1, 'next block');

    // Then
    await expect(reply).resolves.toBe('block');
    await expect(next).resolves.toBe('next block');
    expect(replies.listIds()).toEqual([]);
  });

  it('As a request channel, I give up on a request and its late reply settles nothing', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const reply = replies.wait(1);
    const timeout = new Error('no reply in time');

    // When
    replies.reject(1, timeout);
    replies.resolve(1, 'block');

    // Then
    await expect(reply).rejects.toBe(timeout);
    expect(replies.listIds()).toEqual([]);
  });

  it('As a channel closing down, I fail every wait and none is left open', async () => {
    // Given
    const replies = createPendingReplies<string, string>();
    const firstReply = replies.wait('a');
    const secondReply = replies.wait('b');
    const closed = new Error('channel closed');
    const settled = [expect(firstReply).rejects.toBe(closed), expect(secondReply).rejects.toBe(closed)];

    // When
    replies.rejectAll(closed);

    // Then
    await Promise.all(settled);
    expect(replies.listIds()).toEqual([]);
  });

  it('As a channel reading progress, I read what a request left with its wait and it is gone once answered', () => {
    // Given
    const replies = createPendingReplies<string, string, { method: string }>();
    void replies.wait('r1', { meta: { method: 'resolveDotName' } });

    // When
    const during = replies.getMeta('r1');
    replies.resolve('r1', 'ok');

    // Then
    expect(during).toEqual({ method: 'resolveDotName' });
    expect(replies.getMeta('r1')).toBeUndefined();
  });

  it('As a channel that reused an id still waiting, I wait on it again and am told at once while the first wait stays', () => {
    // Given
    const replies = createPendingReplies<number, string>();
    void replies.wait(1);

    // When
    const error = catchError(() => replies.wait(1));

    // Then
    expect(error).toMatchObject({ message: 'A reply to id 1 is already awaited' });
    expect(replies.listIds()).toEqual([1]);
  });
});
