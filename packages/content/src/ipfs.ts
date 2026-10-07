// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// IPFS gateway utilities.

import { getActiveServicesConfig } from '@dotli/config';
import { endpointHost } from '@dotli/shared';

export function defaultGateway(): string {
  const [gateway] = getActiveServicesConfig().bulletin.ipfsGateways;
  if (gateway === undefined) {
    throw new Error('No IPFS gateway configured for the active network.');
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
    headers: { Accept: 'application/vnd.ipld.raw' },
  });

  if (!response.ok) {
    throw new Error(`IPFS fetch failed: HTTP ${httpStatus(response)} from ${gatewayHost(gateway)} for ${cid}`);
  }

  const contentType = response.headers.get('content-type') ?? undefined;
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
export async function fetchCarFromIpfs(cid: string, gateway: string = defaultGateway()): Promise<Uint8Array> {
  const url = `${gateway}/ipfs/${cid}?format=car`;

  // The URL selects CAR format. A media-specific Accept header bypasses the
  // gateway's immutable-URL cache even though it returns the same archive.
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`IPFS CAR fetch failed: HTTP ${httpStatus(response)} from ${gatewayHost(gateway)} for ${cid}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/** The host part of a gateway URL, which is what tells two gateways apart in a report. */
export function gatewayHost(gateway: string): string {
  return endpointHost(gateway) ?? gateway;
}

function httpStatus(response: Response): string {
  return response.statusText === '' ? String(response.status) : `${String(response.status)} ${response.statusText}`;
}
