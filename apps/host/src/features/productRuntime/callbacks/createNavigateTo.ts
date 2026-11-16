// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Takes a normalized URL. `.dot` names map to a host subdomain and localhost products
// to the host origin, under the tab's local root when it has one. Products take over the tab as on the mobile hosts,
// websites open apart.

import type { Navigation } from '@parity/truapi-host';
import { LOCAL_ROOT, BASE_DOMAIN, getActiveTldSuffix } from '@dotli/config';
import { dotNsUrl } from '@dotli/resolver';

/** The tab the product runs in. */
export type NavigationPage = {
  /** The tab's location, read on each navigation. Never throws. */
  location: () => Pick<Location, 'protocol' | 'port' | 'assign'>;
  /** The local root the tab is served under, or `null` when deployed. */
  localRoot: string | null;
  /** Opens a website apart from the product's tab. Never throws. */
  open: (url: string, options: OpenParams) => void;
};

/** How a website opens, as `window.open` takes it. */
type OpenParams = {
  /** The browsing context the website opens in. */
  target: string;
  /** The window features, such as `noopener`. */
  features: string;
};

type Params = {
  /** The tab the product runs in. The browser's own by default. */
  page?: NavigationPage;
};

const browserPage: NavigationPage = {
  location: () => window.location,
  localRoot: LOCAL_ROOT,
  open: (url, { target, features }) => {
    window.open(url, target, features);
  },
};

/** Opens a `.dot` or localhost product in the product's tab and a website in a new one. Never rejects. */
export function createNavigateTo({ page = browserPage }: Params = {}): Navigation['navigateTo'] {
  function navigateTo(url: string): Promise<void> {
    const location = page.location();

    /** A URL on the host, under `subdomain` when given: on the tab's local root when it has one, else deployed. */
    function buildHostUrl(subdomain: string | null, path: string): string {
      const authority = page.localRoot === null ? BASE_DOMAIN : `${page.localRoot}:${location.port}`;
      const host = subdomain === null ? authority : `${subdomain}.${authority}`;
      return `${location.protocol}//${host}${path ? '/' + path : ''}`;
    }

    const dotUrl = dotNsUrl.parseDotNsDomain(url);
    if (dotUrl) {
      const label = dotUrl.identifier.slice(0, -getActiveTldSuffix().length);
      location.assign(buildHostUrl(label, dotUrl.pathname));
      return Promise.resolve(undefined);
    }

    const localhostUrl = dotNsUrl.parseLocalhostUrl(url);
    if (localhostUrl) {
      const { host, pathname } = localhostUrl;
      location.assign(buildHostUrl(null, pathname ? `${host}/${pathname}` : host));
      return Promise.resolve(undefined);
    }

    // `noopener`, so the site cannot steer this tab through `window.opener`.
    page.open(url, { target: '_blank', features: 'noopener' });
    return Promise.resolve(undefined);
  }

  return navigateTo;
}
