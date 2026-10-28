// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';

/** Records a worker breadcrumb under the protocol flow, with `data` as its attributes. Never throws. */
export function logWorkerEvent(message: string, data?: Record<string, unknown>): void {
  log.event(message, { flow: 'protocol', ...data });
}
