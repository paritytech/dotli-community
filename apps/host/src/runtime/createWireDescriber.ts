// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The debug panel's view of each TrUAPI frame, described by a chunk that loads only in debug mode.

import { decodeWireMessage } from '@parity/truapi';
import { createLazyLoad } from '@dotli/shared';
import { debugBus } from '@dotli/truapi-debug';
import { createReporter } from '@dotli/metrics';
import { loadWireDescriber } from '../lazy.js';
import { reportLazyMiss } from '../reportLazyMiss.js';
import { walletModeState } from './state/walletModeState.js';

const report = createReporter({ flow: 'ui' });

type Params = {
  /** Loads the describer's chunk. Rejects when it fails to load. */
  load: typeof loadWireDescriber;
};

/** Where a frame crossed, and which product's connection it crossed. */
type EmitWireFrameDebugParams = {
  direction: 'incoming' | 'outgoing';
  productId: string;
  message: Uint8Array;
};

/**
 * The describer's chunk, loaded one load at a time, so frames reach the panel in the order they crossed. A failed load
 * rejects that frame and the next frame loads again, while only the first miss of the page is reported.
 */
export function createWireDescriber({ load }: Params) {
  return {
    /** Resolves with the describer's chunk, and rejects when it fails to load. */
    preload: createLazyLoad({
      load,
      onFirstMiss: error => {
        reportLazyMiss({ report, step: 'wire_describe_load', error });
      },
    }),
  };
}

/** The page's describer. Preloading it early keeps the first frames from waiting on the chunk. */
export const wireDescriber = createWireDescriber({ load: loadWireDescriber });

/** Shows `message` to the debug panel when it listens. Never throws, and a describer that fails to load drops it. */
export function emitWireFrameDebug({ direction, productId, message }: EmitWireFrameDebugParams): void {
  if (!debugBus.hasListeners()) {
    return;
  }
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    return;
  }
  const { requestId, payload } = decoded.value;
  const decodeWalletFrames = walletModeState.isLocal();
  // Off the transport path: a panel listener that throws becomes a rejection the page reports, and delivery goes on.
  void wireDescriber.preload().then(
    ({ describeWireFrame }) => {
      debugBus.emit({
        kind: 'truapi',
        direction,
        productId,
        requestId,
        payload: describeWireFrame(payload, payload.value, { decodeWalletFrames }),
      });
    },
    () => {
      // Reported once where it loads.
    },
  );
}
