// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ProtocolFatalError,
  ProtocolInitFailedError,
} from "@dotli/protocol/errors";
import { getActiveServicesConfig } from "@dotli/config/network";
import { endpointHost, gatewayUnreachable } from "@dotli/shared/error-copy";
import type { ResolverErrorName } from "@dotli/resolver/errors";

// Annotated, not inferred: renaming the resolver's error class has to fail
// here at compile time. `instanceof` is unavailable because the error arrived
// over postMessage, so only the name survives.
const NETWORK_SYNC_TIMEOUT: ResolverErrorName = "NetworkSyncTimeoutError";

export const HOST_ERRORS = {
  FATAL_PANIC: "The light client (smoldot) crashed unexpectedly.",
  SW_FAILED_TO_START: "The light client failed to start on the shared worker.",
  SW_SYNC_TIMEOUT:
    "The light client couldn't sync in time on the shared worker.",
  SW_TIMED_OUT: "The light client timed out during startup.",
  HUB_SYNC_TIMEOUT:
    "Light client timed out syncing to Asset Hub - no connection with peers.",
  LIGHT_CLIENT_TIMEOUT: "The connection with other peers is too slow.",
  RPC_TIMEOUT: "The trusted provider didn't respond in time.",
  NETWORK_DROPPED: "The connection to the network dropped while loading.",
  BITSWAP_NO_PEERS:
    "No connected peers have the app files requested right now.",
  ARCHIVE_TRUNCATED: "The download stopped before all the app files arrived.",
  ARCHIVE_NO_INDEX: "This app was published without a start page.",
  MODULE_FETCH_FAILED: "Couldn't load app resources — reload to retry.",
  CHAIN_SPEC_REJECTED:
    "The light client couldn't load the chain configuration.",
  CONTENTHASH_UNSUPPORTED: "This domain's content format isn't supported.",
} as const;

/**
 * Failures reproducible on demand via `?__error=<key>`, honoured only in debug
 * builds (see `forcedError`). Each entry is a real error seen in the wild, kept
 * verbatim so the error page can be worked on without recreating the outage.
 */
const FORCED_ERRORS = new Map<string, () => Error>([
  [
    "chainhead-disjointed",
    () => new Error("ProtocolResponseError: ChainHead disjointed"),
  ],
  [
    "light-client-timeout",
    () => new Error("Light client timed out waiting for peers"),
  ],
  [
    "bitswap-no-peers",
    () =>
      new Error(
        "bitswap_v1_get failed (code=-32810): No connected peers have the CID requested.",
      ),
  ],
  ["failed-to-fetch", () => new TypeError("Failed to fetch")],
  ["unexpected-end-of-data", () => new Error("Unexpected end of data")],
  [
    "archive-missing-index",
    () =>
      new Error(
        "Archive missing index.html — cannot render a sandbox without a root document.",
      ),
  ],
  [
    "archive-cache-missing-index",
    () =>
      new Error(
        "Archive cache hit missing index.html — cannot render a sandbox without a root document.",
      ),
  ],
  ["protocol-fatal", () => new ProtocolFatalError("smoldot panicked")],
  [
    "protocol-init-failed",
    () => new ProtocolInitFailedError("shared worker init failed"),
  ],
  [
    "module-fetch-failed",
    () =>
      new Error(
        "Failed to fetch dynamically imported module: /assets/render.js",
      ),
  ],
  ["contenthash-unsupported", () => new Error("Failed to decode contenthash")],
]);

/**
 * The error named by `?__error=` on the current URL, or `null` when the
 * parameter is absent, unknown, or the build is not a debug build.
 */
export function forcedError(search: string, debug: boolean): Error | null {
  if (!debug) {
    return null;
  }
  const key = new URLSearchParams(search).get("__error");
  if (key === null) {
    return null;
  }
  return FORCED_ERRORS.get(key)?.() ?? null;
}

export const FAILOVER_BTN_LABELS = {
  "rpc-gateway": "Try Trusted Provider",
  "smoldot-shared-worker": "Try Light Client",
} as const;

export const RELOAD_BTN_LABEL = "Reload";

export const OPEN_SETTINGS_BTN_LABEL = "Open Settings";

export const TRY_ANYWAY_BTN_LABEL = "Try Anyway";

export const GO_BACK_BTN_LABEL = "Go Back";

/**
 * Shown before dropping to a trusted provider. The point the visitor has to
 * weigh is who is vouching for the app, so the copy names that party and says
 * nothing else.
 */
export function trustedProviderWarning(
  domain: string,
  provider: string,
): (string | { strong: string })[] {
  return [
    { strong: domain },
    ` will load through ${provider} instead of being verified by your browser. You will trust ${provider} to serve you the real app.`,
  ];
}

/**
 * Host of the endpoint the gateway backend dials first. `getWsProvider` walks
 * the list in order, so the first entry is the one the visitor would actually
 * be trusting.
 */
export function trustedProviderHost(): string {
  return (
    endpointHost(getActiveServicesConfig().assethub.rpcs.at(0)) ??
    "a trusted provider"
  );
}

export type Recovery = "switch-backend" | "reload" | "none";

/** Default: the name never resolved, so there is nothing to download yet. */
export const RESOLUTION_TITLE = "Domain can't be reached";

/** The name resolved and the CID is known; the bytes are what went missing. */
export const CONTENT_TITLE = "This app couldn't be downloaded";

/** The files arrived intact and are simply not a runnable app. */
export const UNUSABLE_TITLE = "This app can't be opened";

/**
 * Stable identity for a classified failure, independent of its copy.
 *
 * Shares its vocabulary with `FORCED_ERRORS` above so the debug harness and the
 * classifier name the same failures the same way. Both archive variants
 * collapse to `archive-missing-index`: they already share one message because
 * they are one fault.
 */
export type ErrorKind =
  | "protocol-fatal"
  | "protocol-init-failed"
  | "chain-spec-rejected"
  | "module-fetch-failed"
  | "contenthash-unsupported"
  | "chainhead-disjointed"
  | "bitswap-no-peers"
  | "failed-to-fetch"
  | "unexpected-end-of-data"
  | "archive-missing-index"
  | "sw-timed-out"
  | "sw-sync-timeout"
  | "hub-sync-timeout"
  | "light-client-timeout"
  | "rpc-timeout"
  | "unknown";

export interface ErrorDescription {
  kind: ErrorKind;
  title: string;
  message: string;
  recovery: Recovery;
  /** What the visitor can check themselves, listed under "Try:". */
  tips: readonly string[];
  /**
   * Whether reloading should also make the protocol iframe purge its worker
   * caches. Set for failures that live in the light client rather than on the
   * wire, where a plain reload would boot straight back into the same state.
   */
  resetProtocol?: boolean;
}

/** Every failure a backend switch can recover from is a reachability problem. */
const CONNECTIVITY_TIPS = ["Checking your internet connection."] as const;

const BITSWAP_TIPS = [
  "Waiting a moment as the app may still be spreading across the network.",
] as const;

// Ordered by what is most likely to work. A provider that fails is far more
// often that provider's problem than the visitor's connection, and the light
// client does not go through it at all. Worded to match the Settings control
// the visitor has to find: the "Network Transport" section in the topbar.
const SWITCH_TRANSPORT_TIP =
  "Changing the Network Transport setting to Light Client mode.";

const GATEWAY_TIPS = [
  SWITCH_TRANSPORT_TIP,
  "Checking your internet connection.",
] as const;

// A connection that opened and then delivered a short body is not a flaky
// link often enough to be worth suggesting. The repeatable cause is an
// incompletely pinned archive, which only whoever published the app can fix.
const TRUNCATED_TIPS = [
  SWITCH_TRANSPORT_TIP,
  "Contacting the app maintainer if this keeps happening.",
] as const;

// Deterministic: the same archive will fail the same way on every reload and
// on either transport, so there is exactly one thing worth saying.
const MAINTAINER_TIPS = ["Contacting the app maintainer."] as const;

/**
 * Map an arbitrary error thrown during resolution to a user-facing message
 * and a recovery hint. `isP2p` toggles copy that would be wrong in the
 * other mode (e.g. calling a dead RPC "light client").
 *
 * Tips default to the connectivity list for anything a backend switch can
 * recover from, because those are reachability failures by definition. A
 * branch that knows better states its own, empty included.
 */
export function describeError(err: unknown, isP2p: boolean): ErrorDescription {
  const described = classifyError(err, isP2p);
  return {
    ...described,
    title: described.title ?? RESOLUTION_TITLE,
    tips:
      described.tips ??
      (described.recovery === "switch-backend" ? CONNECTIVITY_TIPS : []),
  };
}

function classifyError(
  err: unknown,
  isP2p: boolean,
): Omit<ErrorDescription, "tips" | "title"> & {
  tips?: readonly string[];
  title?: string;
} {
  // Every branch below names its `kind`, so a new branch that forgets one is a
  // compile error rather than a silently unkeyed error page.
  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof ProtocolFatalError) {
    return {
      kind: "protocol-fatal",
      message: HOST_ERRORS.FATAL_PANIC,
      recovery: "switch-backend",
    };
  }
  // Specific message matches run before the generic init-failed fallback so
  // a more descriptive message (e.g. "chain spec rejected") isn't masked by
  // the broad `ProtocolInitFailedError` branch.
  if (msg.includes("chain spec") || msg.includes("Chain spec")) {
    return {
      kind: "chain-spec-rejected",
      message: HOST_ERRORS.CHAIN_SPEC_REJECTED,
      recovery: "switch-backend",
    };
  }
  if (msg.includes("Failed to fetch dynamically imported module")) {
    return {
      kind: "module-fetch-failed",
      message: HOST_ERRORS.MODULE_FETCH_FAILED,
      recovery: "reload",
    };
  }
  if (
    msg.includes("non-IPFS contenthash") ||
    msg.includes("Failed to decode contenthash")
  ) {
    return {
      kind: "contenthash-unsupported",
      message: HOST_ERRORS.CONTENTHASH_UNSUPPORTED,
      recovery: "none",
    };
  }
  // polkadot-api's `DisjointError`, matched on its message because the error
  // reaches us over postMessage with only its text intact. It is raised when
  // the `chainHead_follow` subscription is torn down with reads still in
  // flight: a node `stop` event, the follow released by another consumer, or
  // the provider transport dropping. None of those are the visitor's network,
  // so there is nothing for them to check — and none of them are fixed by a
  // plain reload either, because the light client that lost the follow lives
  // in the protocol iframe and survives one. Hence the purge on reload.
  if (msg.includes("ChainHead disjointed")) {
    return {
      kind: "chainhead-disjointed",
      message: HOST_ERRORS.NETWORK_DROPPED,
      recovery: "switch-backend",
      tips: [],
      resetProtocol: true,
    };
  }
  // The four content-failure branches below do not fire in production yet.
  // `renderAppSubdomain` mounts the sandbox iframe and returns without awaiting
  // the fetch, so the archive failures are raised and rendered inside
  // apps/sandbox, which still shows its own "Failed to load content" screen.
  // They are reachable through the `?__error=` harness, and they are written
  // here rather than there because this is where the classifier belongs once
  // the sandbox reuses it. Until then, changing this copy changes the harness
  // only. See `failLoading` in apps/sandbox/src/main.ts for the live screen.
  //
  // The name resolved and the CID is known; no peer smoldot is connected to
  // is serving those blocks. Nothing about the visitor's machine is wrong, so
  // the only suggestion is the one thing that changes the outcome on its own:
  // more peers picking the content up.
  if (
    msg.includes("No connected peers have the CID") ||
    msg.includes("code=-32810")
  ) {
    return {
      kind: "bitswap-no-peers",
      title: CONTENT_TITLE,
      message: HOST_ERRORS.BITSWAP_NO_PEERS,
      recovery: "switch-backend",
      tips: BITSWAP_TIPS,
    };
  }
  // A bare `TypeError: Failed to fetch` means the browser never opened the
  // connection at all — DNS, TLS, CORS or simply being offline. It can only
  // come from an HTTPS dependency, so it is the gateway mode's; the P2P modes
  // reach the network over smoldot and fail differently. Must stay below the
  // dynamic-import branch above, whose message starts the same way.
  if (!isP2p && msg.includes("Failed to fetch")) {
    return {
      kind: "failed-to-fetch",
      title: CONTENT_TITLE,
      message: gatewayUnreachable(trustedProviderHost()),
      recovery: "switch-backend",
      tips: GATEWAY_TIPS,
    };
  }
  // `@ipld/car`'s decoder ran out of bytes mid-block: the CAR body was cut
  // short in transit. The name resolved and the CID is right, so this is a
  // download failure rather than a reachability one. Every occurrence on
  // record carries `dependency: ipfs-gateway`, so the advice does not branch
  // on the mode the way the timeout copy does.
  if (msg.includes("Unexpected end of data")) {
    return {
      kind: "unexpected-end-of-data",
      title: CONTENT_TITLE,
      message: HOST_ERRORS.ARCHIVE_TRUNCATED,
      recovery: "switch-backend",
      tips: TRUNCATED_TIPS,
    };
  }
  // Both the fresh-fetch and cache-hit variants mean the same thing: the
  // archive has no `index.html` at its root. The cache was filled from that
  // same archive, so purging it would re-fetch the identical fault.
  if (msg.includes("missing index.html")) {
    return {
      kind: "archive-missing-index",
      title: UNUSABLE_TITLE,
      message: HOST_ERRORS.ARCHIVE_NO_INDEX,
      recovery: "none",
      tips: MAINTAINER_TIPS,
    };
  }
  if (msg.includes("did not signal ready")) {
    return {
      kind: "sw-timed-out",
      message: HOST_ERRORS.SW_TIMED_OUT,
      recovery: "switch-backend",
    };
  }
  // Pre-sync deadline: the worker *did* boot, it just couldn't sync in time.
  // Distinct from a SharedWorker that never started at all.
  if (msg.includes("did not complete")) {
    return {
      kind: "sw-sync-timeout",
      message: HOST_ERRORS.SW_SYNC_TIMEOUT,
      recovery: "switch-backend",
    };
  }
  if (
    err instanceof Error &&
    err.name === NETWORK_SYNC_TIMEOUT &&
    isP2p &&
    msg.includes("Asset Hub")
  ) {
    return {
      kind: "hub-sync-timeout",
      message: HOST_ERRORS.HUB_SYNC_TIMEOUT,
      recovery: "switch-backend",
    };
  }
  if (err instanceof ProtocolInitFailedError) {
    return {
      kind: "protocol-init-failed",
      message: HOST_ERRORS.SW_FAILED_TO_START,
      recovery: "switch-backend",
    };
  }
  if (msg.includes("timed out") || msg.includes("Timed out")) {
    return {
      kind: isP2p ? "light-client-timeout" : "rpc-timeout",
      message: isP2p
        ? HOST_ERRORS.LIGHT_CLIENT_TIMEOUT
        : HOST_ERRORS.RPC_TIMEOUT,
      recovery: "switch-backend",
    };
  }
  return { kind: "unknown", message: msg, recovery: "switch-backend" };
}
