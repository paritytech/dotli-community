// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** An IPFS gateway's network that answers every request with `body`. */
export function createGatewayFetch(body: Uint8Array): typeof fetch {
  return () => Promise.resolve(new Response(body.slice()));
}
