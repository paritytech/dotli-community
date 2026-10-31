// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { raceAbort, type Settle } from './raceAbort.js';

describe('raceAbort', () => {
  const reasons = [
    { label: 'an AbortError', reason: new DOMException('stop', 'AbortError') },
    { label: 'an Error', reason: new Error('gone') },
    { label: 'a string', reason: 'the visitor left' },
    { label: 'a TimeoutError', reason: new DOMException('t', 'TimeoutError') },
  ];

  it.each(reasons)(
    'As a helper on a signal aborted with $label, I call raceAbort and it rejects at once with that reason',
    async ({ reason }) => {
      // Given
      const controller = new AbortController();
      controller.abort(reason);
      const start = vi.fn(() => () => undefined);

      // When
      const raced = raceAbort({ signal: controller.signal, start });

      // Then
      await expect(raced).rejects.toBe(reason);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each(reasons)(
    'As a helper whose signal aborts with $label, I call raceAbort and it rejects with that reason',
    async ({ reason }) => {
      // Given
      const controller = new AbortController();
      const { signal } = controller;
      const added = vi.spyOn(signal, 'addEventListener');
      const removed = vi.spyOn(signal, 'removeEventListener');
      const cleanup = vi.fn();
      const raced = raceAbort<string>({ signal, start: () => cleanup });

      // When
      controller.abort(reason);

      // Then
      await expect(raced).rejects.toBe(reason);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
    },
  );

  it('As a helper whose work settles, I call raceAbort and it leaves no abort listener', async () => {
    // Given
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const cleanup = vi.fn();
    let settle: Settle<string> | undefined;
    const raced = raceAbort<string>({
      signal,
      start: settleRace => {
        settle = settleRace;
        return cleanup;
      },
    });

    // When
    settle?.resolve('done');

    // Then
    await expect(raced).resolves.toBe('done');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
  });

  it('As a helper whose work settles inside start, I call raceAbort and it resolves with that outcome and runs the cleanup', async () => {
    // Given
    const { signal } = new AbortController();
    const removed = vi.spyOn(signal, 'removeEventListener');
    const cleanup = vi.fn();

    // When
    const raced = raceAbort<string>({
      signal,
      start: settle => {
        settle.resolve('done');
        return cleanup;
      },
    });

    // Then
    await expect(raced).resolves.toBe('done');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('As a helper whose work fails inside start, I call raceAbort and it rejects with that outcome and runs the cleanup', async () => {
    // Given
    const cleanup = vi.fn();
    const failure = new Error('failed at once');

    // When
    const raced = raceAbort<string>({
      start: settle => {
        settle.reject(failure);
        return cleanup;
      },
    });

    // Then
    await expect(raced).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('As a helper whose start throws, I call raceAbort and it rejects with what was thrown and leaves no abort listener', async () => {
    // Given
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const thrown = new Error('start failed');

    // When
    const raced = raceAbort<string>({
      signal,
      start: () => {
        throw thrown;
      },
    });

    // Then
    await expect(raced).rejects.toBe(thrown);
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
  });
});
