// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded overlays chunk. Only overlays/load.ts imports it.

import { ensureOverlayRoot, mountRoot, ToastStack } from '@dotli/ui';
import type { Reporter } from '@dotli/ui-core';
import { ModalOutlet } from './ModalOutlet.js';

export interface OverlayViews {
  /** Without one, the toast stack itself. */
  toastStack?: typeof ToastStack;
}

/**
 * Mount the toast and modal trees.
 * `onBroken` runs once the root broke and was disposed, so the loader can settle queued work.
 */
export function mountOverlays(onBroken: () => void, report: Reporter, views: OverlayViews = {}): () => void {
  const Toasts = views.toastStack ?? ToastStack;
  return mountRoot(
    'overlays',
    ensureOverlayRoot(),
    () => (
      <>
        <Toasts />
        <ModalOutlet />
      </>
    ),
    { report, onBroken },
  );
}
