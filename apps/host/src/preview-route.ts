// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isLocalhost } from "@dotli/config/config";
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
    // A localhost preview target is only honoured when the host shell is
    // itself served from a local origin. A deployed origin (dot.li, paseo.li,
    // ...) must never proxy a visitor's localhost into the trusted host origin.
    const targetIsLocalhost =
      isLocalhost && dotNsUrl.parseLocalhostUrl(target.toString()) !== null;
    const isWebContainer =
      target.protocol === "https:" &&
      dotNsUrl.isWebcontainerPreviewHost(target.hostname);

    if (
      (!targetIsLocalhost && !isWebContainer) ||
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
