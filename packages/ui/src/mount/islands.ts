// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's side of the shell's islands (the Astro page, see
// src/islands/): their failures, and taking them out of the
// page. Solid-free: the host's startup path runs it.

import { captureException } from '@dotli/metrics';
import { disableAuthModal } from '../auth-controller.js';

interface HydrationErrorDetail {
  error: unknown;
  componentUrl: string | null;
}

/**
 * Report an island that failed to load or hydrate (Astro's
 * `astro:hydration-error`), in place of Astro's console log. Without the auth
 * modal island the auth modal is disabled (disableAuthModal), so a login
 * never holds the blocking-modal lease for a modal nobody can see.
 */
export function reportIslandErrors(): void {
  document.addEventListener('astro:hydration-error', ev => {
    ev.preventDefault();
    const island = ev.target instanceof Element ? ev.target : null;
    const component = island?.getAttribute('component-export') ?? 'unknown';
    const { error } = (ev as CustomEvent<HydrationErrorDetail>).detail;
    captureException(error, { kind: 'island_hydration_error', root: `island:${component}` });
    if (component === 'AuthModal') {
      disableAuthModal();
    }
  });
}

/**
 * Remove `root` from the page, unmounting the islands in it (or the one it
 * is in) first: Astro disposes an island on `astro:unmount`, never on its
 * element leaving the page. An island not hydrated yet just goes. Does
 * nothing for null.
 */
export function unmountIslands(root: Element | null): void {
  if (root === null) {
    return;
  }
  const outer = root.closest('astro-island') ?? root;
  for (const island of [outer, ...outer.querySelectorAll('astro-island')]) {
    if (island.localName === 'astro-island') {
      island.dispatchEvent(new CustomEvent('astro:unmount'));
    }
  }
  outer.remove();
}
