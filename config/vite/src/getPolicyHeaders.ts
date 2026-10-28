// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HeaderPolicy } from './getHeaderPolicy.ts';

/** What every policy sends. */
const SHARED_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** What every policy but `isolated` sends. */
const SAME_ORIGIN_FRAME_HEADERS: Readonly<Record<string, string>> = {
  ...SHARED_HEADERS,
  'X-Frame-Options': 'SAMEORIGIN',
};

/** What a page no other page may frame sends on top of its other headers. */
export const UNFRAMED_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
};

/**
 * Returns a new object holding the security headers of `policy`. `frameAncestors` fills an isolated page's CSP. Never
 * throws.
 */
export function getPolicyHeaders(policy: HeaderPolicy, frameAncestors: string): Record<string, string> {
  switch (policy) {
    case 'isolated':
      return {
        ...SHARED_HEADERS,
        'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin',
      };
    case 'worker-coep':
      return { ...SAME_ORIGIN_FRAME_HEADERS, 'Cross-Origin-Embedder-Policy': 'credentialless' };
    case 'unframed':
      return { ...SAME_ORIGIN_FRAME_HEADERS, ...UNFRAMED_HEADERS };
    case 'plain':
      return { ...SAME_ORIGIN_FRAME_HEADERS };
  }
}
