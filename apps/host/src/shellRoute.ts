// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which page the shell is: a product by its `.dot` label in the hostname or the path, a local or preview target in debug
// builds, or no product at all. Read from the URL alone.

import { BASE_DOMAIN } from '@dotli/config';
import { dotNsUrl, isValidDotName } from '@dotli/resolver';
import { log } from '@dotli/shared';
import { parseDotLabel } from './parseDotLabel.js';
import { parsePreviewTargetUrl } from './parsePreviewTargetUrl.js';

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
  /** The service workers registered on this origin. */
  workers: () => Promise<readonly { unregister: () => Promise<boolean> }[]>;
};

type GetLandingOriginParams = Pick<LeaveForLandingParams['location'], 'protocol' | 'port'> &
  Pick<LeaveForLandingParams, 'localRoot'>;

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
] as const;

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
    return { kind: 'preview', url: previewUrl, host: new URL(previewUrl).host, productId };
  }
  const localhostUrl = readLocalhostProxyUrl?.(location) ?? null;
  if (localhostUrl !== null) {
    return { kind: 'localhost', url: localhostUrl, host: new URL(localhostUrl).host, productId };
  }
  return readPathProduct(location.pathname) ?? { kind: 'landing' };
}

/**
 * A link to a product on the bare host: `/<name>` or `/<name>.dot`, then the product's own path. The only way to a
 * subname, whose host a wildcard certificate does not cover. A one-letter segment names no product, since no
 * registered name is that short.
 */
function readPathProduct(pathname: string): ShellRoute | null {
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
  if (value === undefined || value === '') {
    return undefined;
  }
  return dotNsUrl.isProductIdentifier(value) ? value : undefined;
}

/**
 * Returns the localhost URL a `/localhost[:port]` path names, without the host's own params, or null for any other
 * path. Never throws. Debug builds only: proxying a visitor's localhost into the trusted host origin is dangerous in
 * production.
 */
export function readLocalhostUrl(location: ShellLocation): string | null {
  const match = /^\/(localhost(?::\d+)?)(.*)$/.exec(location.pathname);
  if (match === null) {
    return null;
  }
  const [, host, rest = ''] = match;
  if (host === undefined) {
    return null;
  }
  // Reserved host params must not leak into the proxied product.
  const productSearch = new URLSearchParams(location.search);
  for (const key of RESERVED_HOST_PARAMS) {
    productSearch.delete(key);
  }
  const query = productSearch.toString();
  return `http://${host}${rest}${query ? `?${query}` : ''}${location.hash}`;
}

/**
 * Returns the URL bar's path once the target renders. The product got the deep path, so the bar must not show it
 * stale. Never throws.
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
 * service worker an older release registered there, or from a host or path that names none. Rejects rather than
 * reloads when neither applies, as a server serving the shell for the landing URL would loop, and rejects as `workers`
 * or an unregister does.
 */
export async function leaveForLanding({ location, localRoot, workers }: LeaveForLandingParams): Promise<void> {
  const { protocol, port, pathname, search } = location;
  const origin = getLandingOrigin({ protocol, port, localRoot });
  const registrations = await workers();
  if (registrations.length === 0 && origin === location.origin && pathname === '/') {
    throw new Error(`leaveForLanding: ${origin}/ answered with the shell, not the landing page`);
  }
  await Promise.all(registrations.map(registration => registration.unregister()));
  log.event('Route: landing page elsewhere', { flow: 'boot', stale_workers: registrations.length });
  location.replace(`${origin}/${search}`);
}

function getLandingOrigin({ protocol, port, localRoot }: GetLandingOriginParams): string {
  if (localRoot === null) {
    return `${protocol}//${BASE_DOMAIN}`;
  }
  const portSuffix = port === '' ? '' : `:${port}`;
  return `${protocol}//${localRoot}${portSuffix}`;
}
