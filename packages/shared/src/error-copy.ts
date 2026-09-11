// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// User-facing error copy shared by the host shell and the sandbox.
//
// The same failure can surface from either app — the host when resolution
// fails, the sandbox when the content fetch does — and a visitor who sees
// both should read the same sentence. Copy that only one app can produce
// stays in that app (`HOST_ERRORS` in apps/host/src/errors.ts).

import { getActiveServicesConfig } from "@dotli/config/network";

/**
 * A trusted-provider HTTPS dependency refused the connection outright:
 * `TypeError: Failed to fetch` from the IPFS gateway, not a timeout.
 *
 * Names the gateway host, because "the trusted provider" is an abstraction
 * the visitor never chose and cannot check, while a hostname is something
 * they can paste into a browser or hand to whoever runs their network.
 */
export function gatewayUnreachable(): string {
  const host = gatewayHost();
  return host === null
    ? "Your browser couldn't connect to the trusted provider."
    : `Your browser couldn't connect to the trusted provider ${host}.`;
}

function gatewayHost(): string | null {
  const gateway = getActiveServicesConfig().bulletin.ipfsGateways.at(0);
  if (gateway === undefined) {
    return null;
  }
  try {
    return new URL(gateway).hostname;
  } catch {
    return gateway;
  }
}
