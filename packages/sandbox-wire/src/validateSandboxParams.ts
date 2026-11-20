// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox cannot read the host's localStorage, so the host delivers every user decision over the contract
// handshake and the sandbox rejects any value it doesn't recognize instead of defaulting. The telemetry id alone
// degrades to none. A new required field bumps SANDBOX_SCHEMA_VERSION, so a stale host can't feed a fresh sandbox.

import { BACKEND_FACTS, NETWORK_NAMES, isValidNetwork, parseBackend, type Backend, type Network } from '@dotli/config';

import { SANDBOX_SCHEMA_VERSION } from './contractParams.js';
import type { SandboxContractMessage } from './sandboxMessages.js';
import { SandboxContractError } from './sandboxContractError.js';

export type SandboxParams = {
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
 * Validates a parsed contract message against the host-to-sandbox contract and returns its params.
 * Throws a `SandboxContractError`: `recoverable` for an absent required field, so the host re-renders the iframe to fix
 * it, and fatal for a present but invalid one, which means a broken host build. A field dropped on receipt reads as
 * absent.
 */
export function validateSandboxContract(contract: SandboxContractMessage): SandboxParams {
  const version = readRequired(contract.v, 'v', 'The host did not pin the contract version.');
  if (version !== String(SANDBOX_SCHEMA_VERSION)) {
    throw new SandboxContractError(
      `Sandbox contract version mismatch (got v=${version}, expected v=${String(SANDBOX_SCHEMA_VERSION)}). Reload from the host to pick up the matching build.`,
    );
  }

  const cid = readRequired(contract.cid, 'cid', 'The host did not propagate the resolved content id.');
  if (!CID_PATTERN.test(cid)) {
    throw new SandboxContractError(`Invalid cid "${cid}". Expected an alphanumeric IPFS content id.`);
  }

  const rawBackend = readRequired(contract.chainBackend, 'chainBackend', 'The host did not specify a backend.');
  const backend = parseBackend(rawBackend);
  if (backend === null) {
    throw new SandboxContractError(
      `Unknown chainBackend "${rawBackend}". Expected one of: ${Object.keys(BACKEND_FACTS)
        .map(b => `"${b}"`)
        .join(', ')}.`,
    );
  }

  const network = readRequired(contract.network, 'network', 'The host did not propagate the active network.');
  if (!isValidNetwork(network)) {
    throw new SandboxContractError(
      `Unknown network "${network}". Expected one of: ${NETWORK_NAMES.map(n => `"${n}"`).join(', ')}.`,
    );
  }

  const resetRaw = contract.fullReset ?? null;
  if (resetRaw !== null && resetRaw !== '1') {
    throw new SandboxContractError(`Invalid fullReset "${resetRaw}". Expected "1" or no value.`);
  }

  const resolutionIdRaw = contract.resolutionId ?? null;
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

/** Throws a recoverable `SandboxContractError` naming `field` when the contract lacks it, with `reason` as the host's fault. */
function readRequired(value: string | undefined, field: string, reason: string): string {
  if (value === undefined) {
    throw new SandboxContractError(`Missing required contract field \`${field}\`. ${reason} Reload from dot.li.`, {
      recoverable: true,
    });
  }
  return value;
}
