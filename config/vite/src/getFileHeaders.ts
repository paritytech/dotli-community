// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ASSETS_PREFIX, SERVICE_WORKER_PATHS } from './siteRoutes.ts';

/**
 * Returns a new object holding the caching and worker scope headers of `pathname`. Asset names are content-hashed, and
 * a worker is revalidated so an update reaches it. Never throws.
 */
export function getFileHeaders(pathname: string): Record<string, string> {
  if (pathname.startsWith(ASSETS_PREFIX)) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  if (SERVICE_WORKER_PATHS.has(pathname)) {
    return { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' };
  }
  return { 'Cache-Control': 'no-cache' };
}
