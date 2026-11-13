// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isExpectedDbError } from '@dotli/storage';
import { createReporter, defineCount } from '@dotli/metrics';

const report = createReporter({ flow: 'notifications' });

/**
 * Count. A step of the scheduled notifications poll failed, once per failing run of the step. Tagged `outcome`
 * (error), `reason` (the error's name) and `step` (`remove_stale, list_pending, claim`). An IndexedDB failure the
 * browser causes is expected, the rest captured.
 */
const notificationsPollMetric = defineCount<'error'>('notifications.poll');

export type PollStep = 'remove_stale' | 'list_pending' | 'claim';

/**
 * Builds the report of the scheduled notifications poll's steps. The poller retries every second, so a step's failure
 * is reported when it starts failing, not on every tick. Never throws.
 */
export function createNotificationsPollReport() {
  const failingSteps = new Set<PollStep>();

  return {
    /** Notes that `step` ran, so its next failure is reported again. */
    succeeded(step: PollStep): void {
      failingSteps.delete(step);
    },
    /** Reports `step`'s failure, unless the step was already failing. */
    failed(step: PollStep, error: unknown): void {
      if (failingSteps.has(step)) {
        return;
      }
      failingSteps.add(step);
      if (isExpectedDbError(error)) {
        report.expected(error, { step, metric: notificationsPollMetric, attributes: { step } });
        return;
      }
      report.defect(error, {
        step,
        metric: notificationsPollMetric,
        message: `[scheduled notifications] ${step} failed:`,
        attributes: { step },
      });
    },
  };
}
