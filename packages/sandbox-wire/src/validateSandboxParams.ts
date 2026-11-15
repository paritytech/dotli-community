// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox cannot read the host's localStorage, so the host passes every user decision as a URL param and the
// sandbox rejects any value it doesn't recognize instead of defaulting. The telemetry id alone degrades to none.
// A new required param bumps SANDBOX_SCHEMA_VERSION, so a stale host can't feed a fresh sandbox.

import { BACKEND_FACTS, NETWORK_NAMES, isValidNetwork, parseBackend, type Backend, type Network } from '@dotli/config';

import { SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION } from './contractParams.js';
import { SandboxContractError } from './sandboxContractError.js';

type SandboxParams = {
  /** The product's content id. */
  cid: string;
  /** The chain backend the host chose. */
  backend: Backend;
  /** The network the host has active. */
  network: Network;
  /** True when the host asks the sandbox to drop its stored state before it loads. */
  fullReset: boolean;
  /** Telemetry only, so never required: no sandbox should fail to boot over a trace id. */
  resolutionId: string | null;
};

// A cheap charset gate. The sandbox parses the CID and hash-verifies fetched content against it.
const CID_PATTERN = /^[a-zA-Z0-9]+$/;

const RESOLUTION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Validates a sandbox URL against the host-to-sandbox contract and returns its params.
 * Throws a `SandboxContractError` on any failure, whose message names the param and the value that broke the contract. The
 * error is `recoverable` for an absent required param: the sandbox strips its params after boot, so this is a reload
 * the host fixes by re-rendering the iframe. A present but invalid param means a broken host build, so it stays fatal.
 */
export function validateSandboxParams(search: URLSearchParams): SandboxParams {
  const version = readRequiredParam(search, SANDBOX_CONTRACT_PARAMS.v, 'The host did not pin the contract version.');
  if (version !== String(SANDBOX_SCHEMA_VERSION)) {
    throw new SandboxContractError(
      `Sandbox contract version mismatch (got v=${version}, expected v=${String(SANDBOX_SCHEMA_VERSION)}). Reload from the host to pick up the matching build.`,
    );
  }

  const cid = readRequiredParam(
    search,
    SANDBOX_CONTRACT_PARAMS.cid,
    'The host did not propagate the resolved content id.',
  );
  if (!CID_PATTERN.test(cid)) {
    throw new SandboxContractError(`Invalid cid "${cid}". Expected an alphanumeric IPFS content id.`);
  }

  const rawBackend = readRequiredParam(
    search,
    SANDBOX_CONTRACT_PARAMS.chainBackend,
    'The host did not specify a backend.',
  );
  const backend = parseBackend(rawBackend);
  if (backend === null) {
    throw new SandboxContractError(
      `Unknown chainBackend "${rawBackend}". Expected one of: ${Object.keys(BACKEND_FACTS)
        .map(b => `"${b}"`)
        .join(', ')}.`,
    );
  }

  const network = readRequiredParam(
    search,
    SANDBOX_CONTRACT_PARAMS.network,
    'The host did not propagate the active network.',
  );
  if (!isValidNetwork(network)) {
    throw new SandboxContractError(
      `Unknown network "${network}". Expected one of: ${NETWORK_NAMES.map(n => `"${n}"`).join(', ')}.`,
    );
  }

  const resetRaw = search.get(SANDBOX_CONTRACT_PARAMS.fullReset);
  if (resetRaw !== null && resetRaw !== '1') {
    throw new SandboxContractError(`Invalid fullReset "${resetRaw}". Expected "1" or no value.`);
  }

  const resolutionIdRaw = search.get(SANDBOX_CONTRACT_PARAMS.resolutionId);
  // Not a uuid check, because the host may fall back to a non-uuid id. An odd value degrades to untagged.
  const resolutionId = resolutionIdRaw !== null && RESOLUTION_ID_PATTERN.test(resolutionIdRaw) ? resolutionIdRaw : null;

  return {
    cid,
    backend,
    network,
    fullReset: resetRaw === '1',
    resolutionId,
  };
}

/** Throws a recoverable `SandboxContractError` naming `param` when the URL lacks it, with `reason` as the host's fault. */
function readRequiredParam(search: URLSearchParams, param: string, reason: string): string {
  const value = search.get(param);
  if (value === null) {
    throw new SandboxContractError(`Missing required URL param \`${param}\`. ${reason} Reload from dot.li.`, {
      recoverable: true,
    });
  }
  return value;
}
