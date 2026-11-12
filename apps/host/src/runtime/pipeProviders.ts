// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { WireProvider as Provider } from '@parity/truapi';
import type { Timers } from '@dotli/shared';
import { debugBus } from '@dotli/truapi-debug';

type Params = {
  product: Provider;
  core: Provider;
  flowId: string;
  label: string;
  productId: string;
  /** Is shown each core frame once it was forwarded to the product. */
  noteForwarded: (message: Uint8Array) => void;
  /** The clock the debug events are stamped with. */
  timers: Pick<Timers, 'now'>;
};

/**
 * Forwards every frame between the product and the core, and closes each side with the other. The debug bus hears the
 * first frame each way. Returns the unpipe, which never throws.
 */
export function pipeProviders({ product, core, flowId, label, productId, noteForwarded, timers }: Params): () => void {
  let sawInbound = false;
  let sawOutbound = false;
  const unsubscribes = [
    product.subscribe(message => {
      if (!sawInbound) {
        sawInbound = true;
        debugBus.emit({
          layer: 'bridge',
          event: 'first_inbound',
          flowId,
          timestamp: timers.now(),
          payload: { label, productId },
        });
      }
      core.postMessage(message);
    }),
    core.subscribe(message => {
      if (!sawOutbound) {
        sawOutbound = true;
        debugBus.emit({
          layer: 'bridge',
          event: 'first_outbound',
          flowId,
          timestamp: timers.now(),
          payload: { label, productId },
        });
      }
      product.postMessage(message);
      noteForwarded(message);
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
      try {
        unsubscribe();
        // eslint-disable-next-line no-restricted-syntax -- provider teardown is best-effort. Stale MessagePorts can already be closed while the next cleanup still must run.
      } catch {
        // Teardown race.
      }
    }
  }

  return disposePipe;
}
