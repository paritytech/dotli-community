// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Holds the page's text selection off while anything holds it. */
export type SelectionLock = ReturnType<typeof createSelectionLock>;

type Params = {
  /** Locks the page's selection on `true` and gives it back on `false`. */
  apply: (locked: boolean) => void;
};

/** A lock over `apply`, locked by the first hold and unlocked by the last release. Building it never throws. */
export function createSelectionLock({ apply }: Params) {
  let holders = 0;

  function hold(): () => void {
    holders += 1;
    if (holders === 1) {
      apply(true);
    }
    let released = false;

    function release(): void {
      if (released) {
        return;
      }
      released = true;
      holders -= 1;
      if (holders === 0) {
        apply(false);
      }
    }

    return release;
  }

  return {
    /** Locks until the returned release, which is safe to call twice. Never throws unless `apply` does. */
    hold,
  };
}

/** The page's one lock, so two drags at once keep selection off until both end. */
export const bodySelection = createSelectionLock({
  apply(locked) {
    document.body.style.userSelect = locked ? 'none' : '';
  },
});
