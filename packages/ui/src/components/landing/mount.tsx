// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded landing chunk. Only landing/load.ts imports it.

import { mountRoot } from "../../mount/root";
import { Landing } from "./Landing";

/**
 * Mount the landing page into `container` as the `"page"` root. `onError`
 * runs after a render error has been reported.
 */
export function mountLanding(
  container: HTMLElement,
  onError?: (err: unknown) => void,
): () => void {
  return mountRoot("page", container, () => <Landing />, { onError });
}
