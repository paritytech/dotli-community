// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Returns a product frame on the page that holds only whether it is connected. */
export function createStandInFrame() {
  const element = { isConnected: true };
  return {
    // A frame's layout reads no other member of it.
    /** The product frame, on the page until `remove` runs. */
    frame: element as HTMLIFrameElement,
    /** Takes the frame off the page. */
    remove() {
      element.isConnected = false;
    },
  };
}
