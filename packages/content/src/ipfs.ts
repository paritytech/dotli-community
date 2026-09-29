// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// IPFS gateway utilities.

import { getActiveServicesConfig } from "@dotli/config";

function defaultGateway(): string {
  const [gateway] = getActiveServicesConfig().bulletin.ipfsGateways;
  if (gateway === undefined) {
    throw new Error("No IPFS gateway configured for the active network.");
  }
  return gateway;
}

/**
 * Fetch content from IPFS by CID via HTTP gateway.
 */
export async function fetchFromIpfs(
  cid: string,
  gateway: string = defaultGateway(),
): Promise<{
  data: Uint8Array;
  contentType?: string;
}> {
  // Request the raw block: a bare GET lets the gateway content-negotiate and
  // mutate the body (e.g. serve it as text/html), breaking CID verification.
  const url = `${gateway}/ipfs/${cid}?format=raw`;

  const response = await fetch(url, {
    headers: { Accept: "application/vnd.ipld.raw" },
  });

  if (!response.ok) {
    throw new Error(
      `IPFS fetch failed: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const arrayBuffer = await response.arrayBuffer();

  return {
    data: new Uint8Array(arrayBuffer),
    ...(contentType !== undefined ? { contentType } : {}),
  };
}

/**
 * Fetch content as CAR archive from the IPFS gateway.
 * The gateway's ?format=car returns the entire directory tree in one response.
 */
export async function fetchCarFromIpfs(
  cid: string,
  gateway: string = defaultGateway(),
): Promise<Uint8Array> {
  const url = `${gateway}/ipfs/${cid}?format=car`;

  const response = await fetch(url, {
    headers: { Accept: "application/vnd.ipld.car" },
  });

  if (!response.ok) {
    throw new Error(
      `IPFS CAR fetch failed: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}
