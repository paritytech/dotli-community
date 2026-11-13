// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { TrUApiProductProvider } from '@parity/truapi-host';
import { createReporter, defineCount } from '@dotli/metrics';
import type { PhoneRequestTracker } from './createPhoneRequestTracker.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. The phone request tap threw on a frame, so that frame went untracked. Tagged `outcome` (error), `reason`
 * (the error's name) and `side` (`product, core`).
 */
const phoneRequestTapMetric = defineCount<'error'>('signing.phone_request_tap');

/**
 * Returns `provider` with every frame either way also shown to `phoneRequests`, and the tap's end. The tracker only
 * infers what it can, so a frame the tap throws on is reported and passes on as if untapped.
 */
export function tapPhoneRequests(provider: TrUApiProductProvider, phoneRequests: PhoneRequestTracker) {
  const tap = phoneRequests.connect();
  const unsubscribe = provider.subscribe(message => {
    tapFrame('core', message);
  });
  // A latch, since a connection ends its tap both as it closes and as its close is heard.
  let untapped = false;

  return {
    provider: {
      ...provider,
      postMessage(message: Uint8Array): void {
        provider.postMessage(message);
        tapFrame('product', message);
      },
    } satisfies TrUApiProductProvider,
    /** Ends the tap, and the connection's claims as gone. Idempotent, and never throws. */
    untap(): void {
      if (untapped) {
        return;
      }
      untapped = true;
      unsubscribe();
      tap.dispose();
    },
  };

  function tapFrame(side: 'product' | 'core', message: Uint8Array): void {
    try {
      switch (side) {
        case 'product':
          tap.fromProduct(message);
          return;
        case 'core':
          tap.fromCore(message);
          return;
      }
    } catch (error) {
      report.defect(error, {
        step: 'phone_request_tap',
        tags: { side },
        metric: phoneRequestTapMetric,
        attributes: { side },
        message: `[dot.li page-core] phone request tap failed on a frame from the ${side}:`,
      });
    }
  }
}
