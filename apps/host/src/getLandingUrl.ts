// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, LOCAL_ROOT } from '@dotli/config';

/** The query param the landing page reads a name to search from. */
export const LANDING_NAME_PARAM = 'q';

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

/** Returns this page's landing address, with `name` as the search the landing page opens on. */
export function getPageLandingUrl(name?: string): string {
  return getLandingUrl({ location: window.location, localRoot: LOCAL_ROOT }, name);
}

/** Returns the name `search` asks the landing page to open on, or null when it holds none. */
export function readLandingName(search: string): string | null {
  const name = new URLSearchParams(search).get(LANDING_NAME_PARAM)?.trim();
  return name === undefined || name === '' ? null : name;
}
