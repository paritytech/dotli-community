// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox cannot read the host's localStorage, so the host passes every user decision as a URL param and the
// sandbox rejects any value it doesn't recognize instead of defaulting.
// The sandbox origin is keyed on the dotNS label, not the CID, so all versions of a product share an origin.
// A new required param bumps SANDBOX_SCHEMA_VERSION, so a stale host can't feed a fresh sandbox.

import { NetworkName, isValidNetwork, type Network } from './network.js';

export const SANDBOX_SCHEMA_VERSION = 3;

// A cheap charset gate. The sandbox parses the CID and hash-verifies fetched content against it.
const CID_PATTERN = /^[a-zA-Z0-9]+$/;

const VALID_CHAIN_BACKENDS: ReadonlySet<string> = new Set(['smoldot-direct', 'smoldot-shared-worker', 'rpc-gateway']);

const VALID_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['0', '1']);

const RESOLUTION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Shared by the host writer, this validator and the sandbox's post-validation strip, so the wire format never drifts.
 */
export const SANDBOX_CONTRACT_PARAMS = {
  cid: 'cid',
  chainBackend: 'chainBackend',
  network: 'network',
  fullReset: 'fullReset',
  resolutionId: 'resolutionId',
  v: 'v',
} as const;

export interface SandboxParams {
  cid: string;
  chainBackend: 'smoldot-direct' | 'smoldot-shared-worker' | 'rpc-gateway';
  network: Network;
  fullReset: boolean;
  /** Telemetry only, so never required: no sandbox should fail to boot over a trace id. */
  resolutionId: string | null;
}

export type SandboxParamsResult =
  { ok: true; params: SandboxParams } | { ok: false; reason: string; recoverable?: boolean };

/**
 * Validates a sandbox URL against the host-to-sandbox contract. The caller shows the reason and stops.
 * `recoverable` marks an absent required param: the sandbox strips its params after boot, so this is a reload the host
 * fixes by re-rendering the iframe. A present but invalid param means a broken host build, so it stays fatal.
 */
export function validateSandboxParams(search: URLSearchParams): SandboxParamsResult {
  // An explicit version must match. A host too old to send one fails the required params below.
  const version = search.get(SANDBOX_CONTRACT_PARAMS.v);
  if (version !== null && version !== String(SANDBOX_SCHEMA_VERSION)) {
    return {
      ok: false,
      reason: `Sandbox contract version mismatch (got v=${version}, expected v=${String(SANDBOX_SCHEMA_VERSION)}). Reload from the host to pick up the matching build.`,
    };
  }

  const cid = search.get(SANDBOX_CONTRACT_PARAMS.cid);
  if (cid === null || cid === '') {
    return {
      ok: false,
      recoverable: cid === null,
      reason:
        'Missing required URL param `cid`. The host did not propagate the resolved content id. Reload from dot.li.',
    };
  }
  if (!CID_PATTERN.test(cid)) {
    return {
      ok: false,
      reason: `Invalid cid "${cid}". Expected an alphanumeric IPFS content id.`,
    };
  }

  const chainBackend = search.get(SANDBOX_CONTRACT_PARAMS.chainBackend);
  if (chainBackend === null) {
    return {
      ok: false,
      recoverable: true,
      reason: 'Missing required URL param `chainBackend`. The host did not specify a backend — reload from dot.li.',
    };
  }
  if (!VALID_CHAIN_BACKENDS.has(chainBackend)) {
    return {
      ok: false,
      reason: `Unknown chainBackend "${chainBackend}". Expected "smoldot-direct", "smoldot-shared-worker", or "rpc-gateway".`,
    };
  }

  const network = search.get(SANDBOX_CONTRACT_PARAMS.network);
  if (network === null) {
    return {
      ok: false,
      recoverable: true,
      reason:
        'Missing required URL param `network`. The host did not propagate the active network — reload from dot.li.',
    };
  }
  if (!isValidNetwork(network)) {
    return {
      ok: false,
      reason: `Unknown network "${network}". Expected one of: ${Object.values(NetworkName)
        .map(n => `"${n}"`)
        .join(', ')}.`,
    };
  }

  const resetRaw = search.get(SANDBOX_CONTRACT_PARAMS.fullReset);
  if (resetRaw !== null && !VALID_BOOLEAN_FLAGS.has(resetRaw)) {
    return {
      ok: false,
      reason: `Invalid fullReset "${resetRaw}" — expected "0" or "1".`,
    };
  }

  const resolutionIdRaw = search.get(SANDBOX_CONTRACT_PARAMS.resolutionId);
  // Not a uuid check, because the host may fall back to a non-uuid id. An odd value degrades to untagged.
  const resolutionId =
    resolutionIdRaw !== null &&
    resolutionIdRaw.length > 0 &&
    resolutionIdRaw.length <= 64 &&
    RESOLUTION_ID_PATTERN.test(resolutionIdRaw)
      ? resolutionIdRaw
      : null;

  return {
    ok: true,
    params: {
      cid,
      chainBackend: chainBackend as 'smoldot-direct' | 'smoldot-shared-worker' | 'rpc-gateway',
      network,
      fullReset: resetRaw === '1',
      resolutionId,
    },
  };
}
