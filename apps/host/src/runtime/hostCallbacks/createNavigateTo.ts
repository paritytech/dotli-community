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

type PageOrigin = Pick<Location, 'protocol' | 'port'>;

type BuildDotTargetUrlParams = {
  location: PageOrigin;
  root: string | null;
  label: string;
  pathname: string;
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
    const dotUrl = dotNsUrl.parseDotNsDomain(url);

    if (dotUrl && dotNsUrl.isDotDomain(dotUrl.identifier)) {
      location.assign(
        buildDotTargetUrl({
          location,
          root: page.localRoot,
          label: getLabelFromIdentifier(dotUrl.identifier),
          pathname: dotUrl.pathname,
        }),
      );
      return Promise.resolve(undefined);
    }

    const localhostUrl = dotNsUrl.parseLocalhostUrl(url);
    if (localhostUrl) {
      const suffix = localhostUrl.pathname ? '/' + localhostUrl.pathname : '';
      location.assign(`${getHostOrigin(location, page.localRoot)}/${localhostUrl.host}${suffix}`);
      return Promise.resolve(undefined);
    }

    // `noopener`, so the site cannot steer this tab through `window.opener`.
    page.open(url, { target: '_blank', features: 'noopener' });
    return Promise.resolve(undefined);
  }

  return navigateTo;
}

/** Returns the label of `identifier`, which must end in the active TLD suffix. */
function getLabelFromIdentifier(identifier: string): string {
  return identifier.slice(0, -getActiveTldSuffix().length);
}

function buildDotTargetUrl({ location, root, label, pathname }: BuildDotTargetUrlParams): string {
  const suffix = pathname ? '/' + pathname : '';
  if (root !== null) {
    return `${location.protocol}//${label}.${root}:${location.port}${suffix}`;
  }
  return `${location.protocol}//${label}.${BASE_DOMAIN}${suffix}`;
}

function getHostOrigin(location: PageOrigin, root: string | null): string {
  if (root !== null) {
    return `${location.protocol}//${root}:${location.port}`;
  }
  return `${location.protocol}//${BASE_DOMAIN}`;
}
