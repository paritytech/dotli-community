// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getDefaultGateway } from './getDefaultGateway.js';
import { readGatewayBody, type GatewayLimits } from './readGatewayBody.js';

type Params = {
  /** The gateway's base URL. The active network's first gateway when not given. */
  gateway?: string;
  /** The page's own `fetch` when not given. */
  fetch?: typeof fetch;
  /** The stall and size limits of the read. The defaults when not given. */
  limits?: GatewayLimits;
};

/** One raw block from an IPFS gateway, unverified. Rejects as the gateway read does. */
export async function fetchFromIpfs(
  cid: string,
  { gateway = getDefaultGateway(), fetch: fetchResource = fetch, limits }: Params = {},
): Promise<{
  data: Uint8Array;
  contentType?: string;
}> {
  // A bare GET lets the gateway content-negotiate and mutate the body, which breaks CID verification.
  const { data, contentType } = await readGatewayBody({
    url: `${gateway}/ipfs/${cid}?format=raw`,
    accept: 'application/vnd.ipld.raw',
    cid,
    gateway,
    failure: 'IPFS fetch failed',
    fetch: fetchResource,
    limits,
  });
  return { data, ...(contentType !== undefined ? { contentType } : {}) };
}

/** A DAG as one CAR from an IPFS gateway, unverified. Rejects as the gateway read does. */
export async function fetchCarFromIpfs(
  cid: string,
  { gateway = getDefaultGateway(), fetch: fetchResource = fetch, limits }: Params = {},
): Promise<Uint8Array> {
  const { data } = await readGatewayBody({
    url: `${gateway}/ipfs/${cid}?format=car`,
    accept: 'application/vnd.ipld.car',
    cid,
    gateway,
    failure: 'IPFS CAR fetch failed',
    fetch: fetchResource,
    limits,
  });
  return data;
}
