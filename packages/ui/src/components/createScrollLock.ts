// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Locks the page's scroll on `true` and gives it back on `false`. */
  setLocked: (locked: boolean) => void;
};

/**
 * A refcounted page lock: each lock holds it, and `setLocked(false)` runs when the last returned unlock does.
 * An unlock that runs twice counts once. Returns the lock function, and neither it nor an unlock throws unless
 * `setLocked` does.
 */
export function createScrollLock({ setLocked }: Params): () => () => void {
  let locks = 0;

  function lock(): () => void {
    locks += 1;
    setLocked(true);
    let locked = true;

    function unlock(): void {
      if (!locked) {
        return;
      }
      locked = false;
      locks -= 1;
      if (locks === 0) {
        setLocked(false);
      }
    }

    return unlock;
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
