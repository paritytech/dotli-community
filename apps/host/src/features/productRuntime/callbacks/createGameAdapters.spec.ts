// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import type { ProductContext } from '@parity/truapi-host';
import { createGameAdapters, type GameReminderScheduler } from './createGameAdapters.js';

const PRODUCT: ProductContext = { productId: asProductId('dim2.dot'), executionKind: 'App' };

describe('game host callbacks', () => {
  it('As a game product, I schedule a reminder and the scheduler holds it under my product id with my label, the reminder text and the start as a number', async () => {
    // Given
    const { scheduler, holdGameReminder } = createFakeScheduler();
    const { scheduleGameReminder } = createGameAdapters({ label: 'dim2', scheduler });

    // When
    await scheduleGameReminder(PRODUCT, 1_800_000_000_000n);

    // Then
    expect(holdGameReminder).toHaveBeenCalledWith({
      productId: PRODUCT.productId,
      title: 'dim2',
      text: 'Your game is starting.',
      scheduledAt: 1_800_000_000_000,
    });
  });

  it('As a game product, I cancel my reminder and the scheduler drops the one held under my product id', async () => {
    // Given
    const { scheduler, cancelGameReminder: cancel } = createFakeScheduler();
    const { cancelGameReminder } = createGameAdapters({ label: 'dim2', scheduler });

    // When
    await cancelGameReminder(PRODUCT);

    // Then
    expect(cancel).toHaveBeenCalledWith(PRODUCT.productId);
  });

  it('As a game product, I schedule or cancel a reminder while the scheduler cannot write it and both reject', async () => {
    // Given
    const { scheduler, holdGameReminder, cancelGameReminder: cancel } = createFakeScheduler();
    holdGameReminder.mockRejectedValue(new Error('store unavailable'));
    cancel.mockRejectedValue(new Error('store unavailable'));
    const { scheduleGameReminder, cancelGameReminder } = createGameAdapters({ label: 'dim2', scheduler });

    // When
    const scheduled = scheduleGameReminder(PRODUCT, 1_800_000_000_000n);
    const cancelled = cancelGameReminder(PRODUCT);

    // Then
    await expect(scheduled).rejects.toThrow('store unavailable');
    await expect(cancelled).rejects.toThrow('store unavailable');
  });
});

/** A scheduler that holds and drops every reminder. */
function createFakeScheduler(): {
  scheduler: GameReminderScheduler;
  holdGameReminder: ReturnType<typeof vi.fn<GameReminderScheduler['holdGameReminder']>>;
  cancelGameReminder: ReturnType<typeof vi.fn<GameReminderScheduler['cancelGameReminder']>>;
} {
  const holdGameReminder = vi.fn<GameReminderScheduler['holdGameReminder']>(() => Promise.resolve());
  const cancelGameReminder = vi.fn<GameReminderScheduler['cancelGameReminder']>(() => Promise.resolve());
  return { scheduler: { holdGameReminder, cancelGameReminder }, holdGameReminder, cancelGameReminder };
}
