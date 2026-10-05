// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ProtocolFatalError, ProtocolInitFailedError } from '@dotli/protocol';
import { getActiveServicesConfig, getBackend, BACKEND_LABELS } from '@dotli/config';

import { endpointHost, gatewayUnreachable } from '@dotli/shared';
import type { ResolverErrorName } from '@dotli/resolver';
import { ERROR_TITLES, HOST_ERRORS } from './error-copy.js';
import { ManifestRejectedError } from './manifest-gate.js';

// Annotated, not inferred: renaming the resolver's error class has to fail
// here at compile time. `instanceof` is unavailable because the error arrived
// over postMessage, so only the name survives.
const NETWORK_SYNC_TIMEOUT: ResolverErrorName = 'NetworkSyncTimeoutError';
// `ApiStoppedError` in `packages/resolver/src/api.ts`, which is not one of the
// package's public error classes, so its name cannot be annotated the same way.
const API_STOPPED = 'ApiStoppedError';

export {
  ERROR_TITLES,
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  HOST_ERRORS,
  HOST_UNAVAILABLE_DETAIL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  TRY_ANYWAY_BTN_LABEL,
} from './error-copy.js';

/**
 * Shown before dropping to a trusted provider. The point the visitor has to
 * weigh is who is vouching for the app, so the copy names those parties and
 * says nothing else.
 */
export function trustedProviderWarning(domain: string, providers: readonly string[]): (string | { strong: string })[] {
  const named = joinHosts(providers);
  return [
    { strong: domain },
    ` will load through ${named} instead of being verified by your browser. You will trust ${
      providers.length > 1 ? 'them' : named
    } to serve you the real app.`,
  ];
}

function joinHosts(hosts: readonly string[]): string {
  const last = hosts.at(-1);
  if (last === undefined) {
    return 'a trusted provider';
  }
  const rest = hosts.slice(0, -1);
  return rest.length === 0 ? last : `${rest.join(', ')} and ${last}`;
}

/**
 * Host of the endpoint the gateway backend dials first, or `undefined` when
 * none is configured. `getWsProvider` walks the list in order, so the first
 * entry is the one the visitor would actually be trusting.
 */
function assethubHost(): string | undefined {
  return endpointHost(getActiveServicesConfig().assethub.rpcs.at(0));
}

function ipfsGatewayHost(): string | undefined {
  return endpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0));
}

/**
 * Every operator the visitor takes on trust by dropping to the gateway backend.
 * Two of them, not one: the host resolves the name over the Asset Hub RPC while
 * the sandbox fetches the app bytes over HTTPS from the IPFS gateway. Deduped
 * because some networks serve both from the same host.
 */
export function trustedProviderHosts(): string[] {
  return [...new Set([assethubHost(), ipfsGatewayHost()].filter((host): host is string => host !== undefined))];
}

export type Recovery = 'switch-backend' | 'reload' | 'none';

/**
 * Stable identity for a classified failure, independent of its copy.
 *
 * Both archive variants collapse to `archive-missing-index`: they already share
 * one message because they are one fault.
 */
export type ErrorKind =
  | 'protocol-fatal'
  | 'protocol-init-failed'
  | 'worker-init-timeout'
  | 'chain-spec-rejected'
  | 'module-fetch-failed'
  | 'contenthash-unsupported'
  | 'manifest-unsupported-version'
  | 'manifest-invalid'
  | 'chainhead-disjointed'
  | 'chain-halted'
  | 'bitswap-no-peers'
  | 'failed-to-fetch'
  | 'unexpected-end-of-data'
  | 'archive-missing-index'
  | 'sw-timed-out'
  | 'sw-sync-timeout'
  | 'hub-sync-timeout'
  | 'light-client-timeout'
  | 'rpc-timeout'
  | 'unknown';

export interface ErrorDescription {
  kind: ErrorKind;
  title: string;
  message: string;
  recovery: Recovery;
  /** What the visitor can check themselves, listed under "Try". */
  tips: readonly string[];
  /**
   * Whether reloading should also make the protocol iframe purge its worker
   * caches. Set for failures that live in the light client rather than on the
   * wire, where a plain reload would boot straight back into the same state.
   */
  resetProtocol?: boolean;
}

/** Every failure a backend switch can recover from is a reachability problem. */
const CONNECTIVITY_TIPS = ['Checking your internet connection.'] as const;

const BITSWAP_TIPS = ['Waiting a moment as the app may still be spreading across the network.'] as const;

// The shared light client serves every dot.li tab and stays dead once it has
// failed, so a reload alone joins the same dead worker while another tab
// keeps it open. Only that backend has a worker to leave.
const SHARED_WORKER_TIPS = ['Closing other dot.li tabs, then reloading.', ...CONNECTIVITY_TIPS] as const;

// Quotes the option verbatim from `BACKEND_LABELS`, which is what the "Network
// transport" section of the Settings panel renders. Names the mode they are not
// already in, because a tip pointing at the mode that just failed is worse than
// no tip. A light-client visitor is sent to the gateway. A gateway visitor is
// sent to the per-tab light client, which is also the default.
const switchTransportTip = (isP2p: boolean): string =>
  `Switching Network transport to "${
    isP2p ? BACKEND_LABELS['rpc-gateway'] : BACKEND_LABELS['smoldot-direct']
  }" in Settings.`;

// Ordered by what is most likely to work. A provider that fails is far more
// often that provider's problem than the visitor's connection. Only the
// gateway branch uses this, so the transport advice is fixed at "Light Client"
// rather than taking a mode it would never be called with.
const gatewayTips = (): readonly string[] => [switchTransportTip(false), 'Checking your internet connection.'];

// A connection that opened and then delivered a short body is not a flaky
// link often enough to be worth suggesting. The repeatable cause is an
// incompletely pinned archive, which only whoever published the app can fix.
const truncatedTips = (isP2p: boolean): readonly string[] => [
  switchTransportTip(isP2p),
  'Contacting the app maintainer if this keeps happening.',
];

// Deterministic: the same archive will fail the same way on every reload and
// on either transport, so there is exactly one thing worth saying.
const MAINTAINER_TIPS = ['Contacting the app maintainer.'] as const;

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
    title: described.title ?? ERROR_TITLES.DOMAIN_UNREACHABLE,
    tips: described.tips ?? (described.recovery === 'switch-backend' ? CONNECTIVITY_TIPS : []),
  };
}

function classifyError(
  err: unknown,
  isP2p: boolean,
): Omit<ErrorDescription, 'tips' | 'title'> & {
  tips?: readonly string[];
  title?: string;
} {
  // Every branch below names its `kind`, so a new branch that forgets one is a
  // compile error rather than a silently unkeyed error page.
  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof ProtocolFatalError) {
    return {
      kind: 'protocol-fatal',
      message: HOST_ERRORS.FATAL_PANIC,
      recovery: 'switch-backend',
    };
  }
  // Specific message matches run before the generic init-failed fallback so
  // a more descriptive message (e.g. "chain spec rejected") isn't masked by
  // the broad `ProtocolInitFailedError` branch.
  if (msg.includes('chain spec') || msg.includes('Chain spec')) {
    return {
      kind: 'chain-spec-rejected',
      message: HOST_ERRORS.CHAIN_SPEC_REJECTED,
      recovery: 'switch-backend',
    };
  }
  if (msg.includes('Failed to fetch dynamically imported module')) {
    return {
      kind: 'module-fetch-failed',
      message: HOST_ERRORS.MODULE_FETCH_FAILED,
      recovery: 'reload',
    };
  }
  // Decided from the records before any download, so a reload or another
  // transport reads the same manifests and reaches the same verdict.
  if (err instanceof ManifestRejectedError) {
    return {
      kind: err.reason === 'unsupported-version' ? 'manifest-unsupported-version' : 'manifest-invalid',
      title: ERROR_TITLES.APP_UNUSABLE,
      message:
        err.reason === 'unsupported-version' ? HOST_ERRORS.MANIFEST_UNSUPPORTED_VERSION : HOST_ERRORS.MANIFEST_INVALID,
      recovery: 'none',
      tips: MAINTAINER_TIPS,
    };
  }
  if (msg.includes('non-IPFS contenthash') || msg.includes('Failed to decode contenthash')) {
    return {
      kind: 'contenthash-unsupported',
      message: HOST_ERRORS.CONTENTHASH_UNSUPPORTED,
      recovery: 'none',
    };
  }
  // polkadot-api's `DisjointError`, matched on its message because the error
  // reaches us over postMessage with only its text intact. It is raised when
  // the `chainHead_follow` subscription is torn down with reads still in
  // flight: a node `stop` event, the follow released by another consumer, or
  // the provider transport dropping. None of those are the visitor's network,
  // so there is nothing for them to check. None of them are fixed by a plain
  // reload either, because the light client that lost the follow lives in the
  // protocol iframe and survives one. Hence the purge on reload.
  if (msg.includes('ChainHead disjointed')) {
    return {
      kind: 'chainhead-disjointed',
      message: HOST_ERRORS.NETWORK_DROPPED,
      recovery: 'switch-backend',
      tips: [],
      resetProtocol: true,
    };
  }
  // The four content-failure branches below cannot fire yet, from anywhere.
  // `renderAppSubdomain` mounts the sandbox iframe and returns without awaiting
  // the fetch, so the archive failures are raised and rendered inside
  // apps/sandbox, which shows its own "Failed to load content" screen. They are
  // written here rather than there because this is where the classifier belongs
  // once the sandbox reuses it. See `failLoading` in apps/sandbox/src/main.ts
  // for the live screen.
  //
  // The name resolved and the CID is known. No peer smoldot is connected to
  // is serving those blocks. Nothing about the visitor's machine is wrong, so
  // the only suggestion is the one thing that changes the outcome on its own:
  // more peers picking the content up.
  if (msg.includes('No connected peers have the CID') || msg.includes('code=-32810')) {
    return {
      kind: 'bitswap-no-peers',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: HOST_ERRORS.BITSWAP_NO_PEERS,
      recovery: 'switch-backend',
      tips: BITSWAP_TIPS,
    };
  }
  // A bare `TypeError: Failed to fetch` means the browser never opened the
  // connection at all: DNS, TLS, CORS or simply being offline. Only an HTTPS
  // dependency raises it, so it belongs to the gateway mode. The P2P modes
  // reach the network over smoldot and fail differently. Must stay below the
  // dynamic-import branch above, whose message starts the same way.
  //
  // Names the IPFS gateway rather than the Asset Hub RPC. Both are trusted
  // providers in this mode, but the RPC is dialled over `wss://` and a failed
  // WebSocket never surfaces as `Failed to fetch`. The gateway is the only one
  // that can produce this error, and the only one the title is about.
  if (!isP2p && msg.includes('Failed to fetch')) {
    return {
      kind: 'failed-to-fetch',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: gatewayUnreachable(ipfsGatewayHost()),
      recovery: 'switch-backend',
      tips: gatewayTips(),
    };
  }
  // `@ipld/car`'s decoder ran out of bytes mid-block: the CAR body was cut
  // short in transit. The name resolved and the CID is right, so this is a
  // download failure rather than a reachability one.
  if (msg.includes('Unexpected end of data')) {
    return {
      kind: 'unexpected-end-of-data',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: HOST_ERRORS.ARCHIVE_TRUNCATED,
      recovery: 'switch-backend',
      tips: truncatedTips(isP2p),
    };
  }
  // Both the fresh-fetch and cache-hit variants mean the same thing: the
  // archive has no `index.html` at its root. The cache was filled from that
  // same archive, so purging it would re-fetch the identical fault.
  if (msg.includes('missing index.html')) {
    return {
      kind: 'archive-missing-index',
      title: ERROR_TITLES.APP_UNUSABLE,
      message: HOST_ERRORS.ARCHIVE_NO_INDEX,
      recovery: 'none',
      tips: MAINTAINER_TIPS,
    };
  }
  if (msg.includes('did not signal ready')) {
    return {
      kind: 'sw-timed-out',
      message: HOST_ERRORS.SW_TIMED_OUT,
      recovery: 'switch-backend',
    };
  }
  // Pre-sync deadline: the worker *did* boot, it just couldn't sync in time.
  // Distinct from a SharedWorker that never started at all.
  if (msg.includes('did not complete')) {
    return {
      kind: 'sw-sync-timeout',
      message: HOST_ERRORS.SW_SYNC_TIMEOUT,
      recovery: 'switch-backend',
    };
  }
  if (err instanceof Error && err.name === NETWORK_SYNC_TIMEOUT && isP2p && msg.includes('Asset Hub')) {
    return {
      kind: 'hub-sync-timeout',
      message: HOST_ERRORS.HUB_SYNC_TIMEOUT,
      recovery: 'switch-backend',
    };
  }
  if (msg.includes('worker init timed out')) {
    return {
      kind: 'worker-init-timeout',
      title: ERROR_TITLES.HOST_UNAVAILABLE,
      message: HOST_ERRORS.WORKER_INIT_TIMEOUT,
      recovery: 'switch-backend',
      tips: [],
      resetProtocol: true,
    };
  }
  if (err instanceof ProtocolInitFailedError) {
    return {
      kind: 'protocol-init-failed',
      message: HOST_ERRORS.SW_FAILED_TO_START,
      recovery: 'switch-backend',
      ...(getBackend() === 'smoldot-shared-worker' ? { tips: SHARED_WORKER_TIPS } : {}),
    };
  }
  if (msg.includes('timed out') || msg.includes('Timed out')) {
    return {
      kind: isP2p ? 'light-client-timeout' : 'rpc-timeout',
      message: isP2p ? HOST_ERRORS.LIGHT_CLIENT_TIMEOUT : HOST_ERRORS.RPC_TIMEOUT,
      recovery: 'switch-backend',
    };
  }
  // The chain under the resolution halted, and so did the one retry the
  // protocol context gives it on the rebuilt chain. Either the pool answered a
  // read in flight (`Chain transport halted`), or the follow stopped
  // (`ApiStoppedError`, `chainHead follow stopped`). Like `chainhead-disjointed`
  // nothing on the visitor's side explains it. Unlike it, nothing survives in
  // the light client either: the next connect rebuilds the chain, so a plain
  // reload is enough and needs no purge.
  if (
    msg.includes('Chain transport halted') ||
    msg.includes('chainHead follow stopped') ||
    (err instanceof Error && err.name === API_STOPPED)
  ) {
    return {
      kind: 'chain-halted',
      message: HOST_ERRORS.NETWORK_DROPPED,
      recovery: 'switch-backend',
      tips: [],
    };
  }
  return { kind: 'unknown', message: msg, recovery: 'switch-backend' };
}
