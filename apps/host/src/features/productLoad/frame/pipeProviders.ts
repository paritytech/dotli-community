// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { WireProvider as Provider } from '@parity/truapi';
import type { Timers } from '@dotli/shared';
import { debugBus } from '@dotli/truapi-debug';

export type PipeProvidersParams = {
  product: Provider;
  core: Provider;
  flowId: string;
  label: string;
  productId: string;
  /** The clock the debug events are stamped with. */
  timers: Pick<Timers, 'now'>;
};

/**
 * Forwards every frame between the product and the core, and closes each side with the other. The debug bus hears the
 * first frame each way. Returns the unpipe.
 */
export function pipeProviders({ product, core, flowId, label, productId, timers }: PipeProvidersParams): () => void {
  let sawInbound = false;
  let sawOutbound = false;
  function emitFirst(event: 'first_inbound' | 'first_outbound'): void {
    debugBus.emit({ layer: 'bridge', event, flowId, timestamp: timers.now(), payload: { label, productId } });
  }
  const unsubscribes = [
    product.subscribe(message => {
      if (!sawInbound) {
        sawInbound = true;
        emitFirst('first_inbound');
      }
      core.postMessage(message);
    }),
    core.subscribe(message => {
      if (!sawOutbound) {
        sawOutbound = true;
        emitFirst('first_outbound');
      }
      product.postMessage(message);
    }),
    product.subscribeClose?.(() => {
      core.dispose();
    }),
    core.subscribeClose?.(() => {
      product.dispose();
    }),
  ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === 'function');

  function disposePipe(): void {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  }

  return disposePipe;
}
