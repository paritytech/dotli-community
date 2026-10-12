// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ProtocolFatalError, ProtocolInitFailedError } from '@dotli/protocol';
import { getActiveServicesConfig, getBackend, BACKEND_LABELS } from '@dotli/config';

import { endpointHost, gatewayUnreachable } from '@dotli/shared';
import type { ResolverErrorName } from '@dotli/resolver';
import { ERROR_TITLES, HOST_ERRORS } from './error-copy.js';
import { ManifestRejectedError } from './manifest-gate.js';

// Annotated, so renaming the resolver's error fails to compile here. Only the name survives postMessage.
const NETWORK_SYNC_TIMEOUT: ResolverErrorName = 'NetworkSyncTimeoutError';
// Not a public error class of the resolver, so it cannot be annotated the same way.
const API_STOPPED = 'ApiStoppedError';

export {
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  TRY_ANYWAY_BTN_LABEL,
} from './error-copy.js';

/** Names only who vouches for the app, since that is what the visitor has to weigh. */
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

/** The first entry, since the gateway backend dials the list in order. */
function assethubHost(): string | undefined {
  return endpointHost(getActiveServicesConfig().assethub.rpcs.at(0));
}

function ipfsGatewayHost(): string | undefined {
  return endpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0));
}

/** The name resolves over the Asset Hub RPC and the bytes come from the IPFS gateway. Some networks host both. */
export function trustedProviderHosts(): string[] {
  return [...new Set([assethubHost(), ipfsGatewayHost()].filter((host): host is string => host !== undefined))];
}

export type Recovery = 'switch-backend' | 'reload' | 'none';

/** Stable identity for a classified failure, independent of its copy. */
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
  /** Purge the protocol iframe's worker caches on reload, for failures a plain reload would boot straight back into. */
  resetProtocol?: boolean;
}

const CONNECTIVITY_TIPS = ['Checking your internet connection.'] as const;

const BITSWAP_TIPS = ['Waiting a moment as the app may still be spreading across the network.'] as const;

// A failed shared light client stays dead while another tab keeps it open, so a reload alone rejoins it.
const SHARED_WORKER_TIPS = ['Closing other dot.li tabs, then reloading.', ...CONNECTIVITY_TIPS] as const;

// Quotes the Settings label verbatim, and names the mode the visitor is not already in.
const switchTransportTip = (isP2p: boolean): string =>
  `Switching Network transport to "${
    isP2p ? BACKEND_LABELS['rpc-gateway'] : BACKEND_LABELS['smoldot-direct']
  }" in Settings.`;

// A failing provider is more often its own problem than the visitor's connection, so switching comes first.
const gatewayTips = (): readonly string[] => [switchTransportTip(false), 'Checking your internet connection.'];

// A short body is rarely a flaky link. The repeatable cause is an incompletely pinned archive only the publisher fixes.
const truncatedTips = (isP2p: boolean): readonly string[] => [
  switchTransportTip(isP2p),
  'Contacting the app maintainer if this keeps happening.',
];

// Deterministic on every reload and transport.
const MAINTAINER_TIPS = ['Contacting the app maintainer.'] as const;

/**
 * `isP2p` picks copy that would be wrong in the other mode. Anything a backend switch recovers from is a reachability
 * failure, so it defaults to the connectivity tips unless its branch states its own.
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
  // A branch that forgets its `kind` is a compile error rather than an unkeyed error page.
  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof ProtocolFatalError) {
    return {
      kind: 'protocol-fatal',
      message: HOST_ERRORS.FATAL_PANIC,
      recovery: 'switch-backend',
    };
  }
  // Specific messages before the broad `ProtocolInitFailedError` branch, which would mask them.
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
  // A reload or another transport reads the same manifests and reaches the same verdict.
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
  // polkadot-api's `DisjointError`: the follow was torn down with reads in flight. Not the visitor's network, and the
  // light client that lost it survives a plain reload in the protocol iframe, hence the purge.
  if (msg.includes('ChainHead disjointed')) {
    return {
      kind: 'chainhead-disjointed',
      message: HOST_ERRORS.NETWORK_DROPPED,
      recovery: 'switch-backend',
      tips: [],
      resetProtocol: true,
    };
  }
  // The four content-failure branches below cannot fire yet: the sandbox raises and renders archive failures itself.
  // They live here for when the sandbox reuses this classifier.
  //
  // No connected peer serves the blocks. Only more peers picking the content up changes that.
  if (msg.includes('No connected peers have the CID') || msg.includes('code=-32810')) {
    return {
      kind: 'bitswap-no-peers',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: HOST_ERRORS.BITSWAP_NO_PEERS,
      recovery: 'switch-backend',
      tips: BITSWAP_TIPS,
    };
  }
  // The browser never opened the connection, which only the gateway's HTTPS fetch raises, never the `wss://` RPC.
  // Must stay below the dynamic-import branch, whose message starts the same way.
  if (!isP2p && msg.includes('Failed to fetch')) {
    return {
      kind: 'failed-to-fetch',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: gatewayUnreachable(ipfsGatewayHost()),
      recovery: 'switch-backend',
      tips: gatewayTips(),
    };
  }
  // The CAR body was cut short in transit, a download failure rather than a reachability one.
  if (msg.includes('Unexpected end of data')) {
    return {
      kind: 'unexpected-end-of-data',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: HOST_ERRORS.ARCHIVE_TRUNCATED,
      recovery: 'switch-backend',
      tips: truncatedTips(isP2p),
    };
  }
  // Fresh fetch and cache hit are one fault, since purging the cache would re-fetch the same archive.
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
  // The worker booted but could not sync in time, unlike a SharedWorker that never started.
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
  // The chain halted, and so did its one retry. Unlike `chainhead-disjointed`, the next connect rebuilds the chain,
  // so a plain reload needs no purge.
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
