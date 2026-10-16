// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which page the shell is: a product by its `.dot` label in the hostname or the path, a local or preview target in debug
// builds, or no product at all. Read from the URL alone.

import { BASE_DOMAIN } from '@dotli/config';
import { dotNsUrl, isValidDotLabel } from '@dotli/resolver';
import { log } from '@dotli/shared';
import { parseDotLabel } from './dot-label.js';
import { parsePreviewTargetUrl } from './preview-route.js';

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

export type ShellLocation = Pick<Location, 'hostname' | 'pathname' | 'search' | 'hash'>;

export interface RouteOptions {
  /** The shell is served from localhost, the only place a product id override is read. */
  localhost: boolean;
  /** The page runs inside another frame. */
  framed: boolean;
  /** Reads the localhost URL to proxy. Only debug builds give one. */
  localhostProxy: ((location: ShellLocation) => string | null) | undefined;
}

/** A target the shell renders by URL rather than by name. */
export interface LocalTarget {
  kind: 'preview' | 'localhost';
  url: string;
  host: string;
  productId: string | undefined;
}

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

export function readShellRoute(location: ShellLocation, options: RouteOptions): ShellRoute {
  const previewUrl = parsePreviewTargetUrl(location);
  if (options.framed && previewUrl === null) {
    return { kind: 'nested' };
  }
  const label = parseDotLabel(location.hostname);
  if (label !== null) {
    return { kind: 'product', label, base: '' };
  }
  const productId = options.localhost ? readProductIdOverride(location.search) : undefined;
  if (previewUrl !== null) {
    return { kind: 'preview', url: previewUrl, host: new URL(previewUrl).host, productId };
  }
  const localhostUrl = options.localhostProxy?.(location) ?? null;
  if (localhostUrl !== null) {
    return { kind: 'localhost', url: localhostUrl, host: new URL(localhostUrl).host, productId };
  }
  return readPathProduct(location.pathname) ?? { kind: 'landing' };
}

/** A link to a product on the bare host: `/<label>` or `/<label>.dot`, then the product's own path. */
function readPathProduct(pathname: string): ShellRoute | null {
  const segment = /^\/([^/]+)/.exec(pathname)?.[1];
  if (segment === undefined) {
    return null;
  }
  // Lowercased as the browser lowercases a hostname, so both spellings of a link reach the same name.
  const label = segment.replace(/\.dot$/i, '').toLowerCase();
  return isValidDotLabel(label) ? { kind: 'product', label, base: `/${segment}` } : null;
}

function readProductIdOverride(search: string): string | undefined {
  const value = new URLSearchParams(search).get(DOTLI_PRODUCT_ID_PARAM)?.trim();
  if (value === undefined || value === '') {
    return undefined;
  }
  return dotNsUrl.isProductIdentifier(value) ? value : undefined;
}

/**
 * Debug builds only: proxying a visitor's localhost into the trusted host origin is dangerous in production. The entry
 * passes this reader under the compile-time flag, so release bundles drop it.
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

/** The URL bar once the target renders. The product got the deep path, so the bar must not show it stale. */
export function localTargetPath(target: LocalTarget): string {
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

export interface LandingDeps {
  location: Pick<Location, 'protocol' | 'port' | 'pathname' | 'search' | 'origin' | 'replace'>;
  localhost: boolean;
  /** The service workers registered on this origin. */
  workers: () => Promise<readonly { unregister: () => Promise<boolean> }[]>;
}

/**
 * The server answers the bare host's root with the landing page, so the shell gets a URL with no product only from a
 * service worker an older release registered there, or from a host or path that names none. Fails rather than reloads
 * when neither applies, as a server serving the shell for the landing URL would loop.
 */
export async function leaveForLanding(deps: LandingDeps): Promise<void> {
  const { protocol, port, pathname, search } = deps.location;
  const origin = deps.localhost
    ? `${protocol}//localhost${port === '' ? '' : `:${port}`}`
    : `${protocol}//${BASE_DOMAIN}`;
  const registrations = await deps.workers();
  if (registrations.length === 0 && origin === deps.location.origin && pathname === '/') {
    throw new Error('the server answered the landing page URL with the shell');
  }
  await Promise.all(registrations.map(registration => registration.unregister()));
  log.event('Route: landing page elsewhere', { flow: 'boot', stale_workers: registrations.length });
  deps.location.replace(`${origin}/${search}`);
}
