// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core serves the game group to the game product alone and refuses a start that is not in the future, so this
// adapter checks neither. The reminder shows as every product notification does, so it asks for no permission.

import type { GamePlatform, ProductContext } from '@parity/truapi-host';
import { createReporter } from '@dotli/metrics';
import type { ScheduledNotifications } from '../../notifications/index.js';

const report = createReporter({ flow: 'notifications' });

/** Where a product's game reminder waits until its game starts. */
export type GameReminderScheduler = Pick<ScheduledNotifications, 'holdGameReminder' | 'cancelGameReminder'>;

type Params = {
  /** The product the reminder comes from, which titles it. */
  label: string;
  /** Where the reminder waits until its game starts, and shows once it does. */
  scheduler: GameReminderScheduler;
};

/**
 * Holds the product's one game reminder in the scheduler, keyed by the product id the core passes. A schedule replaces
 * the reminder the product held, and a cancel settles when it held none. Both reject when the scheduler cannot write
 * the reminder, which the core answers as a host failure.
 */
export function createGameAdapters({ label, scheduler }: Params): Required<GamePlatform> {
  async function scheduleGameReminder({ productId }: ProductContext, startsAt: bigint): Promise<void> {
    report.log.event('schedule game reminder');
    await scheduler.holdGameReminder({
      productId,
      title: label,
      text: 'Your game is starting.',
      scheduledAt: Number(startsAt),
    });
  }

  function cancelGameReminder({ productId }: ProductContext): Promise<void> {
    return scheduler.cancelGameReminder(productId);
  }

  return { scheduleGameReminder, cancelGameReminder };
}
