// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// User-facing error copy shared by the host shell and the sandbox.
//
// The same failure can surface from either app. The host raises it when
// resolution fails, the sandbox when the content fetch does, and a visitor who
// sees both should read the same sentence. Copy that only one app can produce
// stays in that app (`HOST_ERRORS` in apps/host/src/errors.ts).

/**
 * A trusted-provider HTTPS dependency refused the connection outright:
 * `TypeError: Failed to fetch`, not a timeout.
 *
 * `host` is the endpoint that actually failed. Both callers name the IPFS
 * gateway, because it is the only HTTPS dependency in gateway mode and so the
 * only one that can raise this: the Asset Hub RPC is dialled over `wss://`, and
 * a failed WebSocket surfaces differently. Naming the host beats naming "the
 * trusted provider", which is an abstraction the visitor never chose and cannot
 * check, where a hostname is something they can paste into a browser or hand to
 * whoever runs their network.
 */
export function gatewayUnreachable(host: string | undefined): string {
  return host === undefined || host === ""
    ? "Your browser couldn't connect to the trusted provider."
    : `Your browser couldn't connect to the trusted provider ${host}.`;
}

/** Hostname of a `wss://` or `https://` endpoint, for use in visitor-facing copy. */
export function endpointHost(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined || endpoint === "") {
    return undefined;
  }
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}
