// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { DEV_HOST_PORT, getLocalRoot } from '@dotli/config';

type Params = {
  /** The root domain the host is deployed under. */
  baseDomain: string;
  /** Whether the page is a development build, where the host has its own dev server. The page's own build by default. */
  dev?: boolean;
};

/** The host's pages a visitor on the sandbox page at `page` can move to: the product's app on the host, and its landing. */
export function getHostUrls(
  page: Pick<Location, 'protocol' | 'hostname' | 'port'>,
  { baseDomain, dev = import.meta.env.DEV }: Params,
): { app: string; landing: string } {
  const localRoot = getLocalRoot(page.hostname, { dev });
  const root = localRoot ?? baseDomain;
  const port = dev ? DEV_HOST_PORT : page.port;
  const host = localRoot !== null && port !== '' ? `${root}:${port}` : root;
  const landing = `${page.protocol}//${host}/`;
  const suffix = `.app.${root}`;
  const label = page.hostname.endsWith(suffix) ? page.hostname.slice(0, -suffix.length) : '';
  if (label === '' || label.includes('.')) {
    return { app: landing, landing };
  }
  return { app: `${page.protocol}//${label}.${host}/`, landing };
}
