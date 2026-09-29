// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded landing chunk. Only landing/load.ts imports it.

import { mountRoot } from "../../mount/root.js";
import { Landing } from "./Landing.js";

/**
 * Mount the landing page into `container` as the `"page"` app root, which
 * takes `container` with it when disposed. `onBroken` runs once the page
 * broke and was disposed.
 */
export function mountLanding(
  container: HTMLElement,
  onBroken: () => void,
): () => void {
  return mountRoot("page", container, () => <Landing />, {
    onBroken,
    removeContainer: true,
  });
}
