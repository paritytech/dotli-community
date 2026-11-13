// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSharedRun } from '@dotli/shared';

type Params = {
  /** Locks the page's scroll on `true` and gives it back on `false`. */
  setLocked: (locked: boolean) => void;
};

/**
 * A refcounted page lock. `setLocked(true)` runs when the first lock takes the page, and `setLocked(false)` when the
 * last unlock runs. An unlock acts once. Returns the lock function, and neither it nor an unlock throws unless
 * `setLocked` does.
 */
function createScrollLock({ setLocked }: Params): () => () => void {
  const run = createSharedRun({ begin: lockPage });

  function lockPage(): () => void {
    setLocked(true);
    return unlockPage;
  }

  function unlockPage(): void {
    setLocked(false);
  }

  function lock(): () => void {
    return run.join();
  }

  return lock;
}

/**
 * Lock page scroll through `data-scroll-locked` on the body until the last returned unlock runs.
 * Not an inline style: the page may set the body's overflow inline for its own layout, and that must outlive the
 * dialog.
 */
export const lockScroll = createScrollLock({
  setLocked(locked) {
    document.body.toggleAttribute('data-scroll-locked', locked);
  },
});
