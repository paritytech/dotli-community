// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product is any host under the active network's TLD. Anything else is a regular website.

import { getActiveTldSuffix } from '@dotli/config';

export type DotNsUrl = {
  identifier: string;
  /** No leading slash. Carries the query and hash. */
  pathname: string;
};

export type LocalhostUrl = {
  host: string;
  /** No leading slash. Carries the query and hash. */
  pathname: string;
};

/** Tells a product host from a regular website, and parses the URLs that name one. */
export const dotNsUrl = {
  isDotDomain,
  isProductIdentifier,
  isWebcontainerPreviewHost,
  parseDotNsDomain,
  parseLocalhostUrl,
};

/** Case-folded, since a `polkadot://` host and a raw identifier keep the case they were typed in. */
function isDotDomain(domain: string): boolean {
  return domain.toLowerCase().endsWith(getActiveTldSuffix());
}

/** Returns whether an id names a product: a host under the active TLD, or `localhost` with or without a port. */
function isProductIdentifier(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.endsWith(getActiveTldSuffix()) || normalized === 'localhost' || normalized.startsWith('localhost:');
}

/** Returns whether a host is a WebContainer preview host, under `webcontainer-api.io`. */
function isWebcontainerPreviewHost(host: string): boolean {
  return host.toLowerCase().endsWith('.webcontainer-api.io');
}

/** A port or userinfo is rejected rather than silently dropped, because names have neither. */
function parseDotNsDomain(url: string): DotNsUrl | null {
  const normalized = url.trim();
  if (normalized.length === 0) {
    return null;
  }

  const parsed = normalized.startsWith('polkadot://') ? parseUrl(normalized) : parseUrlAssumingHttps(normalized);
  if (parsed === null) {
    return null;
  }
  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '' || !isDotDomain(parsed.hostname)) {
    return null;
  }

  return {
    identifier: parsed.hostname.toLowerCase(),
    pathname: parsed.pathname.replace(/^\//, '') + parsed.search + parsed.hash,
  };
}

/** Parses a `localhost` URL, with or without a scheme, into its host and path, or `null` for any other host. */
function parseLocalhostUrl(url: string): LocalhostUrl | null {
  const normalized = url.trim();
  if (normalized.length === 0) {
    return null;
  }

  const withProtocol = normalized.startsWith('localhost') ? 'http://' + normalized : normalized;
  const parsed = parseUrl(withProtocol);
  if (parsed?.hostname !== 'localhost') {
    return null;
  }

  return {
    host: parsed.host,
    pathname: parsed.pathname.replace(/^\//, '') + parsed.search + parsed.hash,
  };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Without a scheme, the input is read as an https URL. */
function parseUrlAssumingHttps(url: string): URL | null {
  return parseUrl(url) ?? parseUrl('https://' + url);
}
