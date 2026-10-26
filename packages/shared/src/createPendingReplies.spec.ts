// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createPendingReplies } from './createPendingReplies.js';
import { catchError } from './testing/catchError.js';

describe('createPendingReplies', () => {
  it('As a request channel, I pass a reply and it settles the wait on its id, while a second reply finds nothing', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const reply = replies.wait(1);

    // When
    const first = replies.resolve(1, 'block');
    const again = replies.resolve(1, 'block again');

    // Then
    await expect(reply).resolves.toBe('block');
    expect([first, again]).toEqual([true, false]);
    expect(replies.listIds()).toEqual([]);
  });

  it('As a request channel, I give up on a request and its late reply settles nothing', async () => {
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

  it('As a channel that died, I fail every open wait and each fails with its own error, none left open', async () => {
    // Given
    const replies = createPendingReplies<string, string>();
    const firstReply = replies.wait('a');
    const secondReply = replies.wait('b');

    // When
    replies.rejectAll(id => new Error(`lost ${id}`));

    // Then
    await expect(firstReply).rejects.toThrow('lost a');
    await expect(secondReply).rejects.toThrow('lost b');
    expect(replies.listIds()).toEqual([]);
  });

  it('As a channel closing down, I fail every wait while one error factory throws and none is left open', async () => {
    // Given
    const replies = createPendingReplies<string, string>();
    const firstReply = replies.wait('a');
    const secondReply = replies.wait('b');
    const settled = [
      expect(firstReply).rejects.toThrow('no error for a'),
      expect(secondReply).rejects.toThrow('lost b'),
    ];

    // When
    replies.rejectAll(id => {
      if (id === 'a') {
        throw new Error('no error for a');
      }
      return new Error(`lost ${id}`);
    });

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

describe('createPendingReplies with a signal', () => {
  it('As a caller with an aborted signal, I wait for a reply and the wait rejects at once without an entry', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const controller = new AbortController();
    controller.abort('the visitor left');

    // When
    const reply = replies.wait(1, { signal: controller.signal });

    // Then
    await expect(reply).rejects.toMatchObject({ name: 'AbortError', message: 'the visitor left' });
    expect(replies.listIds()).toEqual([]);
  });

  it('As a caller that aborts, I stop waiting for a reply and a late reply finds nothing', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const controller = new AbortController();
    const reply = replies.wait(1, { signal: controller.signal });

    // When
    controller.abort(new Error('the fetch was cancelled'));
    const late = replies.resolve(1, 'block');

    // Then
    await expect(reply).rejects.toMatchObject({ name: 'AbortError', message: 'The reply wait was aborted' });
    expect(late).toBe(false);
    expect(replies.listIds()).toEqual([]);
  });

  it('As a caller whose reply arrives, I wait with a signal and leave no abort listener on it', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const reply = replies.wait(1, { signal });

    // When
    replies.resolve(1, 'block');

    // Then
    await expect(reply).resolves.toBe('block');
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
  });

  it('As a caller whose wait is rejected, I wait with a signal and leave no abort listener on it', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const reply = replies.wait(1, { signal });
    const timeout = new Error('no reply in time');

    // When
    replies.reject(1, timeout);

    // Then
    await expect(reply).rejects.toBe(timeout);
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
  });

  it('As a channel that died, I fail every wait made with a signal and leave no abort listener on it', async () => {
    // Given
    const replies = createPendingReplies<number, string>();
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const reply = replies.wait(1, { signal });
    const lost = new Error('channel lost');

    // When
    replies.rejectAll(() => lost);

    // Then
    await expect(reply).rejects.toBe(lost);
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
  });
});
