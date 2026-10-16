// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product is any host under the active network's TLD. Anything else is a regular website.
// No metrics here, since `@dotli/metrics` depends on this package. Callers record parse failures.

import { getActiveTldSuffix } from '@dotli/config';

export interface DotNsUrl {
  identifier: string;
  /** No leading slash. Carries the query and hash. */
  pathname: string;
}

export type DotNsUrlResult =
  | { kind: 'ok'; url: DotNsUrl }
  | { kind: 'empty' }
  | { kind: 'parse-error'; reason: string }
  | { kind: 'not-dot-domain'; hostname: string }
  | { kind: 'port-or-userinfo'; hostname: string };

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

function parseUrlWithExplicitHttps(url: string, options: { assumeHttps: boolean }): URL | null {
  const direct = parseUrl(url);
  if (direct !== null) {
    return direct;
  }
  if (!options.assumeHttps) {
    return null;
  }
  return parseUrl('https://' + url);
}

/**
 * Parse a product URL into a discriminated result, since each failure warrants a different UI hint.
 * A port or userinfo is rejected rather than silently dropped, because names have neither.
 */
export function parseDotNsDomainResult(url: string): DotNsUrlResult {
  const normalized = url.trim();
  if (normalized.length === 0) {
    return { kind: 'empty' };
  }

  const parsed = normalized.startsWith('polkadot://')
    ? parseUrl(normalized)
    : parseUrlWithExplicitHttps(normalized, { assumeHttps: true });

  if (parsed === null) {
    return { kind: 'parse-error', reason: 'URL constructor rejected input' };
  }

  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') {
    return { kind: 'port-or-userinfo', hostname: parsed.hostname };
  }

  if (!isDotDomain(parsed.hostname)) {
    return { kind: 'not-dot-domain', hostname: parsed.hostname };
  }

  return {
    kind: 'ok',
    url: {
      identifier: parsed.hostname.normalize('NFC').toLowerCase(),
      pathname: parsed.pathname.replace(/^\//, '') + parsed.search + parsed.hash,
    },
  };
}

/** Prefer `parseDotNsDomainResult`. */
function parseDotNsDomain(url: string): DotNsUrl | null {
  const result = parseDotNsDomainResult(url);
  return result.kind === 'ok' ? result.url : null;
}

export interface LocalhostUrl {
  host: string;
  /** No leading slash. Carries the query and hash. */
  pathname: string;
}

export type LocalhostUrlResult =
  | { kind: 'ok'; url: LocalhostUrl }
  | { kind: 'empty' }
  | { kind: 'parse-error' }
  | { kind: 'not-localhost'; hostname: string };

export function parseLocalhostUrlResult(url: string): LocalhostUrlResult {
  const normalized = url.trim();
  if (normalized.length === 0) {
    return { kind: 'empty' };
  }

  const withProtocol = normalized.startsWith('localhost') ? 'http://' + normalized : normalized;

  const parsed = parseUrl(withProtocol);
  if (parsed === null) {
    return { kind: 'parse-error' };
  }
  if (parsed.hostname !== 'localhost') {
    return { kind: 'not-localhost', hostname: parsed.hostname };
  }

  return {
    kind: 'ok',
    url: {
      host: parsed.host,
      pathname: parsed.pathname.replace(/^\//, '') + parsed.search + parsed.hash,
    },
  };
}

/** Prefer `parseLocalhostUrlResult`. */
function parseLocalhostUrl(url: string): LocalhostUrl | null {
  const result = parseLocalhostUrlResult(url);
  return result.kind === 'ok' ? result.url : null;
}

export type NormalizeUrlResult = { kind: 'ok'; url: string } | { kind: 'empty' } | { kind: 'parse-error'; raw: string };

/** Ensure a URL has a protocol so it opens as absolute, not relative. */
export function normalizeUrlResult(url: string): NormalizeUrlResult {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return { kind: 'empty' };
  }
  const parsed = parseUrlWithExplicitHttps(trimmed, { assumeHttps: true });
  if (parsed === null) {
    return { kind: 'parse-error', raw: url };
  }
  return { kind: 'ok', url: parsed.href };
}

/** Returns the raw input on failure. Prefer `normalizeUrlResult`. */
function normalizeUrl(url: string): string {
  const result = normalizeUrlResult(url);
  switch (result.kind) {
    case 'ok':
      return result.url;
    case 'empty':
      return url;
    case 'parse-error':
      return result.raw;
  }
}

export const dotNsUrl = {
  isDotDomain,
  isProductIdentifier,
  isWebcontainerPreviewHost,
  parseDotNsDomain,
  parseLocalhostUrl,
  normalizeUrl,
};
