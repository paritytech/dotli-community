// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The security and framing headers production sends, split as nginx's header snippets are. Both Node servers send
// these, so the functional tests run under the same sandbox isolation as a deploy.

/**
 * `isolated` is a cross-origin isolated or embeddable page. `worker-coep` is a host asset, whose worker script must
 * carry COEP itself or the isolated /__preview page cannot start it.
 */
export type HeaderPolicy = 'isolated' | 'worker-coep' | 'plain';

export function securityHeaders(policy: HeaderPolicy): Record<string, string> {
  const shared = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (policy !== 'isolated') {
    const plain = { ...shared, 'X-Frame-Options': 'SAMEORIGIN' };
    return policy === 'worker-coep' ? { ...plain, 'Cross-Origin-Embedder-Policy': 'credentialless' } : plain;
  }
  return {
    ...shared,
    // Ports matter: CSP host-sources without one mean the scheme's default.
    'Content-Security-Policy': 'frame-ancestors http://localhost:* http://*.localhost:*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}
