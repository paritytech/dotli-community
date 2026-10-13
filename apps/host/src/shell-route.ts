// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which page the shell is: a product by its `.dot` label, a local or preview target in debug builds, or no product at
// all. Read from the URL alone, then handed to the route's own wiring.

import { BASE_DOMAIN } from '@dotli/config';
import { dotNsUrl } from '@dotli/resolver';
import { log } from '@dotli/shared';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
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
  | { kind: 'product'; label: string }
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
    return { kind: 'product', label };
  }
  const productId = options.localhost ? readProductIdOverride(location.search) : undefined;
  if (previewUrl !== null) {
    return { kind: 'preview', url: previewUrl, host: new URL(previewUrl).host, productId };
  }
  const localhostUrl = options.localhostProxy?.(location) ?? null;
  if (localhostUrl !== null) {
    return { kind: 'localhost', url: localhostUrl, host: new URL(localhostUrl).host, productId };
  }
  return { kind: 'landing' };
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

/** What every route shares once the host is up. */
export interface ShellServices {
  emit: (event: DotliDebugEvent) => void;
  flowId: string;
}

export interface ShellDeps<Services extends ShellServices> {
  route: ShellRoute;
  /** Drawn from the URL alone, before any await, so the URL bar paints with the page. */
  showProductPill: (label: string) => void;
  showLocalhostPill: (host: string) => void;
  /** Starts the debug tools, the sandbox channel, the settings and the bridge. */
  startShell: () => Promise<Services>;
  openLocalTarget: (target: LocalTarget, services: Services) => Promise<void>;
  openProduct: (label: string, services: Services) => Promise<void>;
  leaveForLanding: () => Promise<void>;
  /** The path the page is on once settings apply, for the debug panel. */
  deepPath: () => string;
}

export async function runShell<Services extends ShellServices>(deps: ShellDeps<Services>): Promise<void> {
  const { route } = deps;
  if (route.kind === 'nested') {
    return;
  }
  performance.mark('dotli:main:start');
  if (route.kind === 'product') {
    deps.showProductPill(route.label);
  } else if (route.kind !== 'landing') {
    deps.showLocalhostPill(route.host);
  }

  const services = await deps.startShell();

  if (route.kind === 'preview') {
    await deps.openLocalTarget(route, services);
    return;
  }
  services.emit({
    layer: 'boot',
    event: 'url_parsed',
    flowId: services.flowId,
    timestamp: Date.now(),
    payload: {
      label: route.kind === 'product' ? route.label : null,
      localhostHost: route.kind === 'localhost' ? route.host : null,
      deepPath: deps.deepPath(),
    },
  });
  if (route.kind === 'landing') {
    await deps.leaveForLanding();
    return;
  }
  if (route.kind === 'product') {
    await deps.openProduct(route.label, services);
    return;
  }
  await deps.openLocalTarget(route, services);
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
