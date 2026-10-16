// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The DotNS resolver of the host page, for the cache calls of products: a product can keep a site by its name, and the
// host keeps the CID that it loads for that name. Only the host page can reach the resolver of its chain backend, so it
// sets the resolver here at boot.

/** Resolves a name without its TLD (`site` for `site.paseo`) to the CID of its contenthash, or null. */
export type DotNameResolver = (label: string) => Promise<string | null>;

let resolver: DotNameResolver | null = null;

export function setDotNameResolver(next: DotNameResolver): void {
  resolver = next;
}

/** The CID of the contenthash of `name` (`site.paseo`, or `site`), or null when the name has none. */
export async function resolveDotNameCid(name: string, tld: string): Promise<string | null> {
  if (resolver === null) {
    throw new Error('Failed: this user agent cannot resolve DotNS names here');
  }
  const lower = name.trim().toLowerCase().replace(/\.$/, '');
  const suffix = `.${tld}`;
  return resolver(lower.endsWith(suffix) ? lower.slice(0, -suffix.length) : lower);
}
