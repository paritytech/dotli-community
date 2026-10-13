// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product is any host under the active network's TLD. Anything else is a regular website.

import { getActiveTldSuffix } from '@dotli/config';

export interface DotNsUrl {
  identifier: string;
  /** No leading slash. Carries the query and hash. */
  pathname: string;
}

/** Names are registered in lowercase ASCII, so the host is NFC-normalized and case-folded first. */
function isDotDomain(domain: string): boolean {
  return domain.normalize('NFC').toLowerCase().endsWith(getActiveTldSuffix());
}

function isProductIdentifier(id: string): boolean {
  const n = id.normalize('NFC').toLowerCase();
  return n.endsWith(getActiveTldSuffix()) || n === 'localhost' || n.startsWith('localhost:');
}

function isWebcontainerPreviewHost(host: string): boolean {
  return host.toLowerCase().endsWith('.webcontainer-api.io');
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
    identifier: parsed.hostname.normalize('NFC').toLowerCase(),
    pathname: parsed.pathname.replace(/^\//, '') + parsed.search + parsed.hash,
  };
}

export interface LocalhostUrl {
  host: string;
  /** No leading slash. Carries the query and hash. */
  pathname: string;
}

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

export const dotNsUrl = {
  isDotDomain,
  isProductIdentifier,
  isWebcontainerPreviewHost,
  parseDotNsDomain,
  parseLocalhostUrl,
};
