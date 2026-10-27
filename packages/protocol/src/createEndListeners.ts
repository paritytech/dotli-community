// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { err, type SubscriptionListeners } from '@dotli/transport';
import type { SubscriptionEnd } from './schema.js';

/**
 * The `interrupt` and `fail` listeners of a protocol subscription as one end. A failure of the library's ends it as
 * `err(failure)`, the `CallError` a protocol interrupt carries.
 */
export function createEndListeners<E>(
  end: (outcome: SubscriptionEnd<E>) => void,
): Pick<SubscriptionListeners<never, SubscriptionEnd<E>>, 'interrupt' | 'fail'> {
  return {
    interrupt: end,
    fail(failure) {
      end(err(failure));
    },
  };
}
