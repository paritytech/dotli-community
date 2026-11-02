// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Flow } from './captureException.js';
import { reportDefect } from './reportDefect.js';
import { spans as S } from './spans.js';

/**
 * For a listener set's `onListenerError`: a throwing listener is a defect in its subscriber, so it is captured, logged
 * and counted under `owner`, while the set's other listeners still hear the value.
 *
 * @example
 * const listeners = createListenerSet<Change>({ onListenerError: reportListener('storage', 'store.change') });
 */
export function reportListener(flow: Flow, owner: string): (error: unknown) => void {
  function reportThrownListener(error: unknown): void {
    reportDefect(error, {
      flow,
      step: 'listener',
      tags: { owner },
      metric: S.LISTENER_DELIVERY,
      message: `[dot.li] A ${owner} listener threw`,
      attributes: { owner },
    });
  }

  return reportThrownListener;
}
