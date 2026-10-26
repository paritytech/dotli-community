// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { raceAbort, type Settle } from './raceAbort.js';

describe('raceAbort', () => {
  it('As a helper on an aborted signal, I call raceAbort and it rejects at once without starting the work', async () => {
    // Given
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const start = vi.fn(() => () => undefined);

    // When
    const raced = raceAbort({ signal: controller.signal, abortMessage: 'The work was aborted', start });

    // Then
    await expect(raced).rejects.toMatchObject({ name: 'AbortError', message: 'The work was aborted' });
    expect(start).not.toHaveBeenCalled();
  });

  it('As a helper whose signal fires, I call raceAbort and it rejects and runs the cleanup', async () => {
    // Given
    const controller = new AbortController();
    const cleanup = vi.fn();
    const raced = raceAbort<string>({
      signal: controller.signal,
      abortMessage: 'The work was aborted',
      start: () => cleanup,
    });

    // When
    controller.abort('the visitor left');

    // Then
    await expect(raced).rejects.toMatchObject({ name: 'AbortError', message: 'the visitor left' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('As a helper that maps the abort reason, I call raceAbort and it rejects with what toRejection makes of it', async () => {
    // Given
    const controller = new AbortController();
    const lost = new Error('the layer was lost');
    const mapped = new Error('the wait was lost', { cause: lost });
    const toRejection = vi.fn((reason: unknown) => (reason === lost ? mapped : new Error('unexpected reason')));
    const raced = raceAbort<string>({ signal: controller.signal, toRejection, start: () => vi.fn() });

    // When
    controller.abort(lost);

    // Then
    await expect(raced).rejects.toBe(mapped);
    expect(toRejection).toHaveBeenCalledTimes(1);
  });

  it('As a helper whose work settles, I call raceAbort and it leaves no abort listener', async () => {
    // Given
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const cleanup = vi.fn();
    let settle: Settle<string> | undefined;
    const raced = raceAbort<string>({
      signal,
      abortMessage: 'The work was aborted',
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
      abortMessage: 'The work was aborted',
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
      abortMessage: 'The work was aborted',
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
      abortMessage: 'The work was aborted',
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
