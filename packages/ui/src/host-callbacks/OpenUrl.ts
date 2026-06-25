// Navigation callback. The Rust core pre-normalizes URLs, but dotli still
// needs to classify the result so `.dot` domains land on the right host
// subdomain and localhost products wrap into the configured host origin.

import type { HostCallbacks } from "@parity/truapi-host/callbacks";
import { isLocalhost, BASE_DOMAIN } from "@dotli/config/config";
import { dotNsUrl } from "@dotli/shared/dotns-url";

function identifierToLabel(identifier: string): string {
  return identifier.slice(0, -".dot".length);
}

function buildDotTargetUrl(label: string, pathname: string): string {
  const suffix = pathname ? "/" + pathname : "";
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

export function createNavigateTo(): HostCallbacks["navigateTo"] {
  return (url) => {
    const dotUrl = dotNsUrl.parseDotNsDomain(url);

    if (dotUrl && dotNsUrl.isDotDomain(dotUrl.identifier)) {
      window.open(
        buildDotTargetUrl(
          identifierToLabel(dotUrl.identifier),
          dotUrl.pathname,
        ),
        "_blank",
      );
      return Promise.resolve(undefined);
    }

    const localhostUrl = dotNsUrl.parseLocalhostUrl(url);
    if (localhostUrl) {
      const suffix = localhostUrl.pathname ? "/" + localhostUrl.pathname : "";
      window.open(`${getHostOrigin()}/${localhostUrl.host}${suffix}`, "_blank");
      return Promise.resolve(undefined);
    }

    window.open(dotNsUrl.normalizeUrl(url), "_blank");
    return Promise.resolve(undefined);
  };
}
