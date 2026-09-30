// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's side of the shell's islands (the Astro page, see
// src/islands/): their failures. Solid-free: the host's startup path runs
// it.

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
