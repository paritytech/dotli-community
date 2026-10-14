// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host to sandbox URL contract.
//
// The sandbox runs on `<label>.app.<root>` and cannot read the host's
// localStorage (different origin). The host MUST thread every user
// decision through URL params on the iframe load, and the sandbox MUST
// reject any contract value it doesn't recognize. A silent default on
// the sandbox side would re-introduce the "user picked X, got Y"
// regression class that the determinism audit eliminated.
//
// The sandbox origin is keyed on the dotns label (not the CID) so all
// versions of a product share an origin. The host owns dotns resolution
// and threads the resolved CID through `?cid=`. The sandbox does not
// re-resolve.
//
// Schema v5 (current):
//
//   Required:
//     ?v=<schema version integer>
//     ?cid=<IPFS content id the host resolved from the dotns label>
//     ?chainBackend=<"smoldot-direct" | "smoldot-shared-worker" | "rpc-gateway">
//     ?network=<"paseo-next-v2" | "previewnet">
//     ?polkaVmEnabled=<"0" | "1">
//
//   Optional:
//     ?fullReset=<"0" | "1">
//     ?executableManifest=<exact UTF-8 App executable text record>
//     ?resolutionId=<correlation id for the telemetry of this page load>
//
// When we add a new required param, bump SANDBOX_SCHEMA_VERSION and
// have the validator reject unmatched versions so stale host builds
// don't feed malformed params to fresh sandbox deploys.

import { NetworkName, isValidNetwork, type Network } from './network.js';
import { SANDBOX_SCHEMA_VERSION } from './host-sandbox-version.js';

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
  polkaVmEnabled: 'polkaVmEnabled',
  fullReset: 'fullReset',
  executableManifest: 'executableManifest',
  resolutionId: 'resolutionId',
  v: 'v',
} as const;

export interface SandboxParams {
  cid: string;
  chainBackend: 'smoldot-direct' | 'smoldot-shared-worker' | 'rpc-gateway';
  network: Network;
  polkaVmEnabled: boolean;
  fullReset: boolean;
  executableManifest: string | null;
  /** Telemetry only, so never required: no sandbox should fail to boot over a trace id. */
  resolutionId: string | null;
}

export type SandboxParamsResult =
  | { ok: true; params: SandboxParams }
  | {
      ok: false;
      reason: string;
      recoverable?: boolean;
      hostUpdateRequired?: boolean;
    };

/**
 * Validates a sandbox URL against the host-to-sandbox contract. The caller shows the reason and stops.
 * `recoverable` marks an absent required param: the sandbox strips its params after boot, so this is a reload the host
 * fixes by re-rendering the iframe. A present but invalid param means a broken host build, so it stays fatal.
 */
export function validateSandboxParams(search: URLSearchParams): SandboxParamsResult {
  // A contract carrying a CID is an active host launch and must identify its
  // schema. A URL with no contract keys is the supported post-boot reload
  // shape; let the missing-CID path below ask the host to reconstruct it.
  const version = search.get(SANDBOX_CONTRACT_PARAMS.v);
  if (
    (version === null && search.has(SANDBOX_CONTRACT_PARAMS.cid)) ||
    (version !== null && version !== String(SANDBOX_SCHEMA_VERSION))
  ) {
    return {
      ok: false,
      hostUpdateRequired: true,
      reason: `Sandbox contract version mismatch (got ${version === null ? 'no version' : `v=${version}`}, expected v=${String(SANDBOX_SCHEMA_VERSION)}). Update dot.li to load the matching host build.`,
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

  const polkaVmRaw = search.get(SANDBOX_CONTRACT_PARAMS.polkaVmEnabled);
  if (polkaVmRaw === null || !VALID_BOOLEAN_FLAGS.has(polkaVmRaw)) {
    return {
      ok: false,
      reason:
        polkaVmRaw === null
          ? 'Missing required URL param `polkaVmEnabled`. The host did not specify whether the experimental runtime is enabled.'
          : `Invalid polkaVmEnabled "${polkaVmRaw}" — expected "0" or "1".`,
    };
  }

  const resetRaw = search.get(SANDBOX_CONTRACT_PARAMS.fullReset);
  if (resetRaw !== null && !VALID_BOOLEAN_FLAGS.has(resetRaw)) {
    return {
      ok: false,
      reason: `Invalid fullReset "${resetRaw}" — expected "0" or "1".`,
    };
  }

  const executableManifest = search.get(SANDBOX_CONTRACT_PARAMS.executableManifest);
  if (
    executableManifest !== null &&
    (executableManifest.length === 0 || new TextEncoder().encode(executableManifest).byteLength > 64 * 1024)
  ) {
    return {
      ok: false,
      reason: 'Invalid executableManifest — expected a non-empty App manifest within 65536 UTF-8 bytes.',
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
      polkaVmEnabled: polkaVmRaw === '1',
      fullReset: resetRaw === '1',
      executableManifest,
      resolutionId,
    },
  };
}
