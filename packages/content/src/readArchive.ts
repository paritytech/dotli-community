// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads content by CID over a verifying block source or over an IPFS gateway, with no marks or metrics.

import { formatDuration } from '@dotli/shared';
import { CID } from 'multiformats/cid';
import { createReporter } from '@dotli/metrics';
import { DAG_PB, RAW } from './codecs.js';
import { fetchCarFromIpfs, fetchFromIpfs } from './fetchFromIpfs.js';
import { getDefaultGateway } from './getDefaultGateway.js';
import { getGatewayHost } from './getGatewayHost.js';
import { isCarFile } from './isCarFile.js';
import { parseIpfsResponse } from './parseIpfsResponse.js';
import type { ArchiveFiles, BlockSource, FetchResult, StatusCallback } from './types.js';
import { assertBlockMatchesCid } from './verify.js';
import { walkUnixFsDag } from './walkUnixFsDag.js';

const report = createReporter({ flow: 'content' });

type ReadViaBitswapParams = {
  /** The root to walk from. */
  rootCid: CID;
  /** A source that already verifies what it returns. */
  verifiedSource: BlockSource;
  /** Receives progress text while the read runs. */
  onStatus?: StatusCallback | undefined;
};

export type ReadViaGatewayParams = {
  /** The CID to read, as a string. */
  cid: string;
  /** The gateway path's network. */
  fetch: typeof fetch;
  /** Receives progress text while the read runs. */
  onStatus?: StatusCallback | undefined;
};

/** Walks from the root over a source that already verifies what it returns. */
export async function readViaBitswap({
  rootCid,
  verifiedSource,
  onStatus,
}: ReadViaBitswapParams): Promise<FetchResult> {
  if (rootCid.code === RAW) {
    onStatus?.('Fetching block via bitswap...');
    return readRawRoot(await verifiedSource(rootCid));
  }

  if (rootCid.code === DAG_PB) {
    onStatus?.('Walking dag-pb via bitswap...');
    return toFetchResult(
      await walkUnixFsDag({ rootCid, blockSource: verifiedSource, parseInnerArchive: parseIpfsResponse }),
    );
  }

  throw new Error(`bitswap-rpc: unsupported root CID codec 0x${rootCid.code.toString(16)} (${rootCid.toString()})`);
}

/** Fetches from the active network's gateway and verifies every block against the requested CID. */
export async function readViaGateway({
  cid: cidString,
  fetch: fetchResource,
  onStatus,
}: ReadViaGatewayParams): Promise<FetchResult> {
  const cid = CID.parse(cidString);
  const gateway = getDefaultGateway();
  const host = getGatewayHost(gateway);
  if (cid.code === DAG_PB) {
    onStatus?.('Fetching archive from IPFS gateway...');
    report.log.event(`Requesting CAR of ${cidString} from ${host}`, { gateway: host });
    const gatewayStart = performance.now();
    const carBuffer = await fetchCarFromIpfs(cidString, { gateway, fetch: fetchResource });
    report.log.event(
      `Fetched ${String(Math.round(carBuffer.length / 1024))} KB CAR from ${host} in ${formatDuration(gatewayStart)}`,
      {
        gateway: host,
        bytes: carBuffer.length,
      },
    );
    onStatus?.('Parsing content...');
    // Untrusted transport, so the CAR is bound to the requested CID.
    const files = await parseIpfsResponse(carBuffer, { expectedRoot: cid });
    return toFetchResult(files);
  }
  if (cid.code === RAW) {
    onStatus?.('Fetching content via IPFS gateway...');
    report.log.event(`Requesting raw block ${cidString} from ${host}`, { gateway: host });
    const gatewayStart = performance.now();
    const { data } = await fetchFromIpfs(cidString, { gateway, fetch: fetchResource });
    report.log.event(
      `Fetched ${String(Math.round(data.length / 1024))} KB from ${host} in ${formatDuration(gatewayStart)}`,
      {
        gateway: host,
        bytes: data.length,
      },
    );
    // Untrusted transport.
    assertBlockMatchesCid(cid, data);
    report.log.event(`Block ${cidString} verified`, { bytes: data.length });
    return readRawRoot(data);
  }
  throw new Error(`Unsupported CID codec for gateway fetch: 0x${cid.code.toString(16)} (cid=${cidString})`);
}

/**
 * A raw root may hold a whole site packed as one CAR. Its bytes already match the root, and the CAR's own blocks are
 * hashed as it is read.
 */
async function readRawRoot(bytes: Uint8Array): Promise<FetchResult> {
  return isCarFile(bytes) ? toFetchResult(await parseIpfsResponse(bytes)) : { type: 'single', content: bytes };
}

function toFetchResult(files: ArchiveFiles): FetchResult {
  const keys = Object.keys(files);
  const index = files['index.html'];
  if (keys.length === 1 && index !== undefined) {
    return { type: 'single', content: index };
  }
  report.log.event(`Archive has ${String(keys.length)} files`, { files: keys.length });
  return { type: 'archive', files };
}
