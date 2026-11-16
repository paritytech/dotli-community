// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, LOCAL_ROOT } from '@dotli/config';
import { isValidDotLabel } from '@dotli/resolver';

/** The query param the landing page reads a name to search from. */
const LANDING_NAME_PARAM = 'q';

export type LandingPage = {
  /** The page's URL, which gives the scheme and the port of a local root. */
  location: Pick<Location, 'protocol' | 'port'>;
  /** The local root the shell is served under, or `null` when deployed. */
  localRoot: string | null;
};

/** Returns the landing page's address, with `name` as the search the landing page opens on. */
export function getLandingUrl({ location, localRoot }: LandingPage, name?: string): string {
  const { protocol, port } = location;
  const host = localRoot === null ? BASE_DOMAIN : `${localRoot}${port === '' ? '' : `:${port}`}`;
  const url = `${protocol}//${host}/`;
  return name === undefined ? url : `${url}?${new URLSearchParams({ [LANDING_NAME_PARAM]: name }).toString()}`;
}

/** Moves this page to the landing page. */
export function openLanding(): void {
  window.location.assign(getLandingUrl({ location: window.location, localRoot: LOCAL_ROOT }));
}

/** Moves this page to the landing page, searching `name`. */
export function searchOnLanding(name: string): void {
  window.location.assign(getLandingUrl({ location: window.location, localRoot: LOCAL_ROOT }, name));
}

/**
 * Returns the name `search` asks the landing page to open on, or undefined when it holds none the landing's form
 * accepts, such as a subname.
 */
export function readLandingName(search: string): string | undefined {
  const name = new URLSearchParams(search).get(LANDING_NAME_PARAM)?.trim() ?? '';
  return isValidDotLabel(name) ? name : undefined;
}
