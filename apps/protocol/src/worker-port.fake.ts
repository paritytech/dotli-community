// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export interface FramePage {
  target: EventTarget;
  /** Hides the page, into the back/forward cache when `persisted`. */
  hide: (persisted: boolean) => void;
}

/** The iframe's page, which hides when the host removes the frame, the tab navigates or the page enters the cache. */
export function createFramePage(): FramePage {
  const target = new EventTarget();
  return {
    target,
    hide: persisted => {
      target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    },
  };
}
