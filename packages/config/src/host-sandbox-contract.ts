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
// re-resolve. Archive caching still keys on the CID so a new CID under
// the same name is never served a stale archive.
//
// Schema v3 (current):
//
//   Required:
//     ?cid=<IPFS content id the host resolved from the dotns label>
//     ?chainBackend=<"smoldot-direct" | "smoldot-shared-worker" | "rpc-gateway">
//     ?network=<"paseo-next-v1" | "paseo-next-v2">
//
//   Optional:
//     ?skipArchiveCache=<"0" | "1">
//     ?fullReset=<"0" | "1">
//     ?v=<schema version integer, reserved for future breakage>
//
// When we add a new required param, bump SANDBOX_SCHEMA_VERSION and
// have the validator reject unmatched versions so stale host builds
// don't feed malformed params to fresh sandbox deploys.

import { isValidNetwork, type Network } from "./network";

export const SANDBOX_SCHEMA_VERSION = 3;

// Cheap CID charset gate (base32 cidv1 / base58btc cidv0 are alphanumeric).
// The sandbox does the authoritative CID.parse, then hash-verifies fetched
// content against this CID: every block on the gateway path, and the root
// block (on top of smoldot's own per-block check) on the bitswap path.
const CID_PATTERN = /^[a-zA-Z0-9]+$/;

/** Known chain backends. The only values the sandbox accepts. */
const VALID_CHAIN_BACKENDS: ReadonlySet<string> = new Set([
  "smoldot-direct",
  "smoldot-shared-worker",
  "rpc-gateway",
]);

const VALID_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["0", "1"]);

/**
 * Single source of truth for the host-to-sandbox URL contract param names.
 * Imported by the host writer (`bridge.ts`), the validator below, and the
 * post-validation strip in the sandbox so the wire format never drifts.
 */
export const SANDBOX_CONTRACT_PARAMS = {
  cid: "cid",
  chainBackend: "chainBackend",
  network: "network",
  skipArchiveCache: "skipArchiveCache",
  fullReset: "fullReset",
  v: "v",
} as const;

export type SandboxContractParam =
  (typeof SANDBOX_CONTRACT_PARAMS)[keyof typeof SANDBOX_CONTRACT_PARAMS];

export interface SandboxParams {
  cid: string;
  chainBackend: "smoldot-direct" | "smoldot-shared-worker" | "rpc-gateway";
  network: Network;
  skipArchiveCache: boolean;
  fullReset: boolean;
}

export type SandboxParamsResult =
  | { ok: true; params: SandboxParams }
  | { ok: false; reason: string };

/**
 * Validate a sandbox URL against the host-to-sandbox contract.
 *
 * Returns a discriminated result. The caller is expected to render the
 * failure reason in the UI and stop. Never substitute defaults silently.
 */
export function validateSandboxParams(
  search: URLSearchParams,
): SandboxParamsResult {
  // Version gate: if the host sends an explicit version token, it must
  // match. Absent `?v=` means "pre-versioned host", a path now rejected
  // post-collapse because the `?backend=` requirement is also new and a
  // pre-collapse host would not emit it.
  const version = search.get(SANDBOX_CONTRACT_PARAMS.v);
  if (version !== null && version !== String(SANDBOX_SCHEMA_VERSION)) {
    return {
      ok: false,
      reason: `Sandbox contract version mismatch (got v=${version}, expected v=${String(SANDBOX_SCHEMA_VERSION)}). Reload from the host to pick up the matching build.`,
    };
  }

  // The CID used to live in the origin (`<cid>.app.<root>`). With the dotns
  // origin it must arrive as a param so the sandbox knows which content to
  // fetch and verify. Missing or malformed is a hard error, never a default.
  const cid = search.get(SANDBOX_CONTRACT_PARAMS.cid);
  if (cid === null || cid === "") {
    return {
      ok: false,
      reason:
        "Missing required URL param `cid`. The host did not propagate the resolved content id. Reload from dot.li.",
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
      reason:
        "Missing required URL param `chainBackend`. The host did not specify a backend — reload from dot.li.",
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
      reason:
        "Missing required URL param `network`. The host did not propagate the active network — reload from dot.li.",
    };
  }
  if (!isValidNetwork(network)) {
    return {
      ok: false,
      reason: `Unknown network "${network}". Expected "paseo-next-v1", "paseo-next-v2", or "previewnet".`,
    };
  }

  const skipRaw = search.get(SANDBOX_CONTRACT_PARAMS.skipArchiveCache);
  if (skipRaw !== null && !VALID_BOOLEAN_FLAGS.has(skipRaw)) {
    return {
      ok: false,
      reason: `Invalid skipArchiveCache "${skipRaw}" — expected "0" or "1".`,
    };
  }

  const resetRaw = search.get(SANDBOX_CONTRACT_PARAMS.fullReset);
  if (resetRaw !== null && !VALID_BOOLEAN_FLAGS.has(resetRaw)) {
    return {
      ok: false,
      reason: `Invalid fullReset "${resetRaw}" — expected "0" or "1".`,
    };
  }

  return {
    ok: true,
    params: {
      cid,
      chainBackend: chainBackend as
        | "smoldot-direct"
        | "smoldot-shared-worker"
        | "rpc-gateway",
      network,
      skipArchiveCache: skipRaw === "1",
      fullReset: resetRaw === "1",
    },
  };
}
