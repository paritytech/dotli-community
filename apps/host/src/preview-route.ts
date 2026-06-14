// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { DEBUG } from "@dotli/config/config";
import { dotNsUrl } from "@dotli/shared/dotns-url";

export function parsePreviewTargetUrl(
  location: Pick<Location, "pathname" | "search">,
): string | null {
  if (location.pathname !== "/__preview") {
    return null;
  }

  const raw = new URLSearchParams(location.search).get("url");
  if (raw === null || raw === "") {
    return null;
  }

  try {
    const target = new URL(raw);
    // A localhost preview target is only honoured in debug builds. Proxying a
    // visitor's localhost into the trusted host origin is gated behind the
    // build-time `VITE_APP_DEBUG` flag (`DEBUG`); production builds (flag unset)
    // never honour a localhost target. Webcontainer preview hosts are always
    // allowed — they are public https origins, not loopback.
    const targetIsAllowedLocalhost =
      DEBUG && dotNsUrl.parseLocalhostUrl(target.toString()) !== null;
    const isWebContainer =
      target.protocol === "https:" &&
      dotNsUrl.isWebcontainerPreviewHost(target.hostname);

    if (
      (!targetIsAllowedLocalhost && !isWebContainer) ||
      target.username ||
      target.password
    ) {
      return null;
    }

    return target.toString();
  } catch {
    return null;
  }
}
