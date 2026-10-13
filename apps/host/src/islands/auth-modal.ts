// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the AuthModal island does beside rendering.

import { createEffect, type Accessor } from 'solid-js';
import type { ReadableStore } from '@dotli/shared';

/**
 * Calls `reveal` each time the modal opens, and as the island mounts on an open one, for the owner's lifetime. The
 * modal hangs from the pill, and a product can ask for a sign-in while the bar is folded into the capsule.
 */
export function useRevealWhileOpen(open: Accessor<boolean>, reveal: () => void): void {
  createEffect(open, isOpen => {
    if (isOpen) {
      reveal();
    }
  });
}

/**
 * A user close that closes only an open modal. A modal the controller already closed (a login that connected) must not
 * cancel the login again.
 */
export function closeWhenOpen(modal: ReadableStore<{ open: boolean }>, close: () => void): () => void {
  return () => {
    if (modal.get().open) {
      close();
    }
  };
}
