// The core pre-normalizes URLs, but `.dot` names still map to a host subdomain and localhost products
// to the host origin. Products take over the tab as on the mobile hosts, websites open apart.

import type { Navigation } from '@parity/truapi-host';
import { isLocalhost, BASE_DOMAIN, getActiveTldSuffix } from '@dotli/config';

import { dotNsUrl } from '@dotli/shared';

// Only ever called behind `isDotDomain`, so the suffix is always present.
function identifierToLabel(identifier: string): string {
  return identifier.slice(0, -getActiveTldSuffix().length);
}

function buildDotTargetUrl(label: string, pathname: string): string {
  const suffix = pathname ? '/' + pathname : '';
  if (isLocalhost) {
    return `http://${label}.localhost:${window.location.port}${suffix}`;
  }
  return `${window.location.protocol}//${label}.${BASE_DOMAIN}${suffix}`;
}

function getHostOrigin(): string {
  if (isLocalhost) {
    return `http://localhost:${window.location.port}`;
  }
  return `${window.location.protocol}//${BASE_DOMAIN}`;
}

export function createNavigateTo(): Navigation['navigateTo'] {
  return url => {
    const dotUrl = dotNsUrl.parseDotNsDomain(url);

    if (dotUrl && dotNsUrl.isDotDomain(dotUrl.identifier)) {
      window.location.assign(buildDotTargetUrl(identifierToLabel(dotUrl.identifier), dotUrl.pathname));
      return Promise.resolve(undefined);
    }

    const localhostUrl = dotNsUrl.parseLocalhostUrl(url);
    if (localhostUrl) {
      const suffix = localhostUrl.pathname ? '/' + localhostUrl.pathname : '';
      window.location.assign(`${getHostOrigin()}/${localhostUrl.host}${suffix}`);
      return Promise.resolve(undefined);
    }

    window.open(url, '_blank', 'noopener');
    return Promise.resolve(undefined);
  };
}
