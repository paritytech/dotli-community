// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { mountLanding } from "@dotli/ui/components/landing/mount";

/**
 * Mount the real landing page as the loader does, into a fresh `#app-view`
 * at the end of `document.body`. The caller mocks `@dotli/ui/recent-labels`,
 * whose shared storage frame happy-dom would try to fetch. `dispose` unmounts
 * the page and removes `#app-view`.
 */
export function mountLandingPage(): {
  view: HTMLElement;
  dispose: () => void;
} {
  const view = document.createElement("div");
  view.id = "app-view";
  document.body.append(view);
  return { view, dispose: mountLanding(view, () => {}) };
}
