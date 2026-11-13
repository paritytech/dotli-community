// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which page the shell is: a product by its `.dot` label in the hostname or the path, a WebContainer preview, a local
// target in debug builds, or no product at all, read from the URL alone. Also the path the URL bar keeps for a local
// target, and the move to the landing page when the URL names no product.

import { BASE_DOMAIN, DEBUG } from '@dotli/config';
import { dotNsUrl, isValidDotName } from '@dotli/resolver';
import { createReporter } from '@dotli/metrics';
import { parseDotLabel } from './parseDotLabel.js';

const report = createReporter({ flow: 'boot' });

export type ShellLocation = Pick<Location, 'hostname' | 'pathname' | 'search' | 'hash'>;

export type ReadShellRouteParams = {
  /** The shell is served from localhost, the only place a product id override is read. */
  localhost: boolean;
  /** The page runs inside another frame. */
  framed: boolean;
  /** Reads the localhost URL to proxy. Only debug builds give one. */
  readLocalhostProxyUrl: ((location: ShellLocation) => string | null) | undefined;
};

/** A target the shell renders by URL rather than by name. */
export type LocalTarget = {
  kind: 'preview' | 'localhost';
  url: string;
  host: string;
  productId: string | undefined;
};

export type ShellRoute =
  | {
      kind: 'product';
      label: string;
      /** The page path ahead of the product's own: `/<label>` where the path names the product, else empty. */
      base: string;
    }
  | LocalTarget
  /** A nested dot.li, which would draw a second topbar. */
  | { kind: 'nested' }
  | { kind: 'landing' };

export type LeaveForLandingParams = {
  /** The page's URL, which the landing page replaces. */
  location: Pick<Location, 'protocol' | 'port' | 'pathname' | 'search' | 'origin' | 'replace'>;
  /** The local root the shell is served under, or `null` when deployed. */
  localRoot: string | null;
};

const DOTLI_PRODUCT_ID_PARAM = 'dotliProductId';

const RESERVED_HOST_PARAMS = [
  'network',
  'chainBackend',
  'skipArchiveCache',
  'skipCidCache',
  'skipWorkerCache',
  'fullReset',
  'v',
  DOTLI_PRODUCT_ID_PARAM,
];

/** Returns the page `location` names. Throws only as `readLocalhostProxyUrl` does. */
export function readShellRoute(
  location: ShellLocation,
  { localhost, framed, readLocalhostProxyUrl }: ReadShellRouteParams,
): ShellRoute {
  const previewUrl = parsePreviewTargetUrl(location);
  if (framed && previewUrl === null) {
    return { kind: 'nested' };
  }
  const label = parseDotLabel(location.hostname);
  if (label !== null) {
    return { kind: 'product', label, base: '' };
  }
  const productId = localhost ? readProductIdOverride(location.search) : undefined;
  if (previewUrl !== null) {
    return { kind: 'preview', url: previewUrl.toString(), host: previewUrl.host, productId };
  }
  const localhostUrl = readLocalhostProxyUrl?.(location) ?? null;
  if (localhostUrl !== null) {
    return { kind: 'localhost', url: localhostUrl, host: new URL(localhostUrl).host, productId };
  }
  return readPathProduct(location.pathname) ?? { kind: 'landing' };
}

/** Returns whether the route is a target the shell renders by URL. */
export function isLocalTarget(route: ShellRoute): route is LocalTarget {
  return route.kind === 'preview' || route.kind === 'localhost';
}

/** Returns the target URL a `/__preview` route names, or null off that route or for a target it may not proxy. */
function parsePreviewTargetUrl(location: Pick<Location, 'pathname' | 'search'>): URL | null {
  if (location.pathname !== '/__preview') {
    return null;
  }
  const raw = new URLSearchParams(location.search).get('url');
  if (raw === null || !URL.canParse(raw)) {
    return null;
  }
  const target = new URL(raw);
  if (target.username || target.password) {
    return null;
  }
  // Proxying a visitor's localhost into the trusted host origin is debug-only, and only over http or https, so a
  // `javascript:` or other scheme naming localhost never reaches the frame. Webcontainer preview hosts are public https
  // origins, so they are always allowed.
  const isAllowedLocalhost =
    DEBUG && (target.protocol === 'http:' || target.protocol === 'https:') && target.hostname === 'localhost';
  const isWebContainer = target.protocol === 'https:' && dotNsUrl.isWebcontainerPreviewHost(target.hostname);
  return isAllowedLocalhost || isWebContainer ? target : null;
}

/**
 * A link to a product on the bare host: `/<name>` or `/<name>.dot`, then the product's own path. The only way to a
 * subname, whose host a wildcard certificate does not cover. A one-letter segment names no product, since no
 * registered name is that short.
 */
function readPathProduct(pathname: string): Extract<ShellRoute, { kind: 'product' }> | null {
  const segment = /^\/([^/]+)/.exec(pathname)?.[1];
  if (segment === undefined) {
    return null;
  }
  // Lowercased as the browser lowercases a hostname, so both spellings of a link reach the same name.
  const label = segment.replace(/\.dot$/i, '').toLowerCase();
  return isValidDotName(label) ? { kind: 'product', label, base: `/${segment}` } : null;
}

function readProductIdOverride(search: string): string | undefined {
  const value = new URLSearchParams(search).get(DOTLI_PRODUCT_ID_PARAM)?.trim();
  return value !== undefined && dotNsUrl.isProductIdentifier(value) ? value : undefined;
}

/**
 * Returns the localhost URL a `/localhost[:port]` path names, without the host's own params, or null for any other
 * path. Debug builds only: proxying a visitor's localhost into the trusted host origin is dangerous in production.
 */
export function readLocalhostUrl(location: ShellLocation): string | null {
  const [, host, rest = ''] = /^\/(localhost(?::\d+)?)(\/.*)?$/.exec(location.pathname) ?? [];
  if (host === undefined) {
    return null;
  }
  // Reserved host params must not leak into the proxied product.
  const productSearch = new URLSearchParams(location.search);
  for (const key of RESERVED_HOST_PARAMS) {
    productSearch.delete(key);
  }
  const query = productSearch.toString();
  const url = `http://${host}${rest}${query ? `?${query}` : ''}${location.hash}`;
  // A port past 65535 matches the path but makes no URL.
  return URL.canParse(url) ? url : null;
}

/**
 * Returns the URL bar's path once the target renders. The product got the deep path, so the bar must not show it
 * stale.
 */
export function getLocalTargetPath(target: LocalTarget): string {
  if (target.kind === 'preview') {
    const search = new URLSearchParams({ url: target.url });
    if (target.productId !== undefined) {
      search.set(DOTLI_PRODUCT_ID_PARAM, target.productId);
    }
    return `/__preview?${search.toString()}`;
  }
  return target.productId === undefined
    ? `/${target.host}`
    : `/${target.host}?${DOTLI_PRODUCT_ID_PARAM}=${encodeURIComponent(target.productId)}`;
}

/**
 * The server answers the bare host's root with the landing page, so the shell gets a URL with no product only from a
 * host or path that names none. Throws rather than reloads when the server answered the landing URL with the shell,
 * since that would loop.
 */
export function leaveForLanding({ location, localRoot }: LeaveForLandingParams): void {
  const { protocol, port, pathname, search } = location;
  const host = localRoot === null ? BASE_DOMAIN : `${localRoot}${port === '' ? '' : `:${port}`}`;
  const origin = `${protocol}//${host}`;
  if (origin === location.origin && pathname === '/') {
    throw new Error(`leaveForLanding: ${origin}/ answered with the shell, not the landing page`);
  }
  report.log.event('Route: landing page elsewhere');
  location.replace(`${origin}/${search}`);
}
