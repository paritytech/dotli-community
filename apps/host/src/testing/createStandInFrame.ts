// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Whether the frame runs a transition until `endTransition`, as it does unless motion is reduced. */
  transitions?: boolean;
};

/** Returns a product frame on the page that holds only whether it is connected and runs a transition, and takes events. */
export function createStandInFrame({ transitions = false }: Params = {}) {
  let running = transitions;
  const element = Object.assign(new EventTarget(), {
    isConnected: true,
    getAnimations: (): readonly unknown[] => (running ? [{ transitionProperty: 'top' }] : []),
  });
  return {
    // A frame's layout reads no other member of it.
    /** The product frame, on the page until `remove` runs. */
    frame: element as HTMLIFrameElement,
    /** Takes the frame off the page. */
    remove() {
      element.isConnected = false;
    },
    /** Replaces the transition the frame runs with another, as a change mid-transition does. */
    replaceTransition() {
      element.dispatchEvent(new Event('transitioncancel'));
    },
    /** Ends the transition the frame runs, as the browser reports it. */
    endTransition() {
      running = false;
      element.dispatchEvent(new Event('transitionend'));
    },
  };
}
