// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSharedRun } from '@dotli/shared';

/** Holds the page's text selection off while anything holds it. */
export type SelectionLock = ReturnType<typeof createSelectionLock>;

type Params = {
  /** Locks the page's selection on `true` and gives it back on `false`. */
  apply: (locked: boolean) => void;
};

/** A lock over `apply`, locked by the first hold and unlocked by the last release. */
export function createSelectionLock({ apply }: Params) {
  const run = createSharedRun({ begin: lock });

  function lock(): () => void {
    apply(true);
    return () => {
      apply(false);
    };
  }

  return {
    /** Locks until the returned release, which is safe to call twice. Throws what `apply` throws. */
    hold: run.join,
  };
}

/** The page's one lock, so two drags at once keep selection off until both end. */
export const bodySelection = createSelectionLock({
  apply(locked) {
    document.body.style.userSelect = locked ? 'none' : '';
  },
});
