// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core pre-normalizes URLs, but `.dot` names still map to a host subdomain and localhost products
// to the host origin, under the tab's local root when it has one. Products take over the tab as on the mobile hosts,
// websites open apart.

import type { Navigation } from '@parity/truapi-host';
import { LOCAL_ROOT, BASE_DOMAIN, getActiveTldSuffix } from '@dotli/config';
import { dotNsUrl } from '@dotli/resolver';

// Only ever called behind `isDotDomain`, so the suffix is always present.
function identifierToLabel(identifier: string): string {
  return identifier.slice(0, -getActiveTldSuffix().length);
}

/** The tab the product runs in. */
export type NavigationPage = {
  location: () => Pick<Location, 'protocol' | 'port' | 'assign'>;
  /** The local root the tab is served under, or `null` when deployed. */
  localRoot: string | null;
  /** Opens a website apart from the product's tab. */
  open: (url: string, target: string, features: string) => void;
};

const browserPage: NavigationPage = {
  location: () => window.location,
  localRoot: LOCAL_ROOT,
  open: (url, target, features) => {
    window.open(url, target, features);
  },
};

type PageOrigin = Pick<Location, 'protocol' | 'port'>;

function buildDotTargetUrl(location: PageOrigin, root: string | null, label: string, pathname: string): string {
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

export function createNavigateTo(page: NavigationPage = browserPage): Navigation['navigateTo'] {
  return url => {
    const location = page.location();
    const dotUrl = dotNsUrl.parseDotNsDomain(url);

    if (dotUrl && dotNsUrl.isDotDomain(dotUrl.identifier)) {
      location.assign(
        buildDotTargetUrl(location, page.localRoot, identifierToLabel(dotUrl.identifier), dotUrl.pathname),
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
    page.open(url, '_blank', 'noopener');
    return Promise.resolve(undefined);
  };
}
