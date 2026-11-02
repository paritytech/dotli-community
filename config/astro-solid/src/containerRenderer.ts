// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AstroRenderer } from 'astro';
import { PACKAGE_NAME } from './packageName.ts';

/** The Solid renderer, for Astro's integration and Container API. */
export function getContainerRenderer(): AstroRenderer {
  return {
    name: PACKAGE_NAME,
    clientEntrypoint: `${PACKAGE_NAME}/client.js`,
    serverEntrypoint: `${PACKAGE_NAME}/server.js`,
  };
}
