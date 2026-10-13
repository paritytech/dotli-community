// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The service worker serves a product's sub-pages under its app prefix. Their head script puts the product's own path
// back in the address bar, so a router reads the path it expects. That script bundles this module, so it imports
// nothing.

/** The path the product expects, or null when `location` is not under `prefix`. */
export function pathWithoutAppPrefix(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  prefix: string,
): string | null {
  if (!location.pathname.startsWith(prefix)) {
    return null;
  }
  return (location.pathname.slice(prefix.length) || '/') + location.search + location.hash;
}
