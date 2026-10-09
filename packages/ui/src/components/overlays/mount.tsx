// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded overlays chunk. Only overlays/load.ts imports it.

import { ensureOverlayRoot } from '../../mount/overlay-root.js';
import { mountRoot } from '../../mount/root.js';
import { ModalOutlet } from './ModalOutlet.js';
import { ToastStack } from './ToastStack.js';

/**
 * Mount the toast and modal trees.
 * `onBroken` runs once the root broke and was disposed, so the loader can settle queued work.
 */
export function mountOverlays(onBroken: () => void): () => void {
  return mountRoot(
    'overlays',
    ensureOverlayRoot(),
    () => (
      <>
        <ToastStack />
        <ModalOutlet />
      </>
    ),
    { onBroken },
  );
}
