// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The path rules of the three builds: which paths the protocol app and the session windows own, where a build keeps its
// hashed assets and its service workers, the file a build answers its root with, and the version file each build
// writes.

/** The three builds, each on its own origin. */
export type Site = 'host' | 'app' | 'protocol';

export type Route = {
  /** The build that answers. */
  site: Site;
  /** The bare host, whose root is the landing page. */
  bare: boolean;
};

/** The protocol app's path, which reaches the protocol build on the bare host. */
export const PROTOCOL_PREFIX = '/p';

/** The folder of a build's content-hashed assets. */
export const ASSETS_PREFIX = '/assets/';

/** The service workers' paths at a build's root. */
export const SERVICE_WORKER_PATHS: ReadonlySet<string> = new Set(['/host-sw.js', '/app-sw.js']);

/** The shell's built file: a product host's root, and the answer to a path that names no file. */
export const SHELL_FILE = 'index.html';

/** The build info file's name at the bundle root. */
export const BUILD_INFO_FILE = 'host_version.json';

/** The session windows' paths on the bare host, which serve the session window at these exact paths only. */
const SESSION_PATHS: ReadonlySet<string> = new Set(['/s/auth', '/s/signout', '/s/manage', '/s/sign']);

/**
 * Whether `pathname` is under the protocol prefix. It is the protocol app's only on the bare host, since on a product
 * host it is the product's own. Never throws.
 */
export function isProtocolPath(pathname: string): boolean {
  return pathname.startsWith(`${PROTOCOL_PREFIX}/`);
}

/**
 * Returns `pathname`'s path in the route's build. The protocol build's files sit at its root, its base adds the
 * prefix, and `host.` under a local root asks for them without it. Never throws.
 */
export function getPathInBuild(route: Route, pathname: string): string {
  return route.site === 'protocol' && isProtocolPath(pathname) ? pathname.slice(PROTOCOL_PREFIX.length) : pathname;
}

/**
 * Whether `pathname` is one of the session windows' paths on the bare host. The decoded path decides, so an encoded
 * spelling keeps the frame refusal. A malformed escape is not one. Never throws.
 */
export function isSessionPath(route: Route, pathname: string): boolean {
  if (!route.bare) {
    return false;
  }
  try {
    return SESSION_PATHS.has(decodeURIComponent(pathname));
  } catch {
    // A malformed escape names no file.
    return false;
  }
}

/** Returns the file that answers `/` on the route. Never throws. */
export function getRootPage(route: Route): string {
  return route.bare ? 'landing.html' : SHELL_FILE;
}
