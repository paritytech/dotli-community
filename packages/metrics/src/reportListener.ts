// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName, log } from '@dotli/shared';

import { captureException, type Flow } from './captureException.js';
import { m } from './metrics.js';
import { spans as S } from './spans.js';

/**
 * For a listener set's `onListenerError`: a throwing listener is a defect in its subscriber, so it is captured, logged
 * and counted under `owner`, while the set's other listeners still hear the value.
 */
export function reportListener(flow: Flow, owner: string): (error: unknown) => void {
  function reportThrownListener(error: unknown): void {
    captureException(error, { flow, step: 'listener', tags: { owner } });
    log.error(`[dot.li] A ${owner} listener threw`, error);
    m.count(S.LISTENER_DELIVERY, { outcome: 'error', reason: getErrorName(error) ?? 'unknown', owner });
  }

  return reportThrownListener;
}
