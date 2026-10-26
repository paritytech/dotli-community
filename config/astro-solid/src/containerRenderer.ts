// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AstroRenderer } from 'astro';

/** The Solid renderer, for Astro's integration and Container API. */
export function getContainerRenderer(): AstroRenderer {
  return {
    name: '@config/astro-solid',
    clientEntrypoint: '@config/astro-solid/client.js',
    serverEntrypoint: '@config/astro-solid/server.js',
  };
}
