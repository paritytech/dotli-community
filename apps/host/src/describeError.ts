// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ProtocolFatalError, ProtocolInitFailedError, ProtocolVersionMismatchError } from '@dotli/protocol';
import {
  getActiveServicesConfig,
  getBackend,
  hasLightClient,
  hasSharedWorker,
  BACKEND_FACTS,
  type Backend,
} from '@dotli/config';

import { CONTENT_ERRORS } from '@dotli/content';
import {
  getEndpointHost,
  getErrorMessage,
  getErrorName,
  describeGatewayUnreachable,
  isChainHaltedRpcError,
} from '@dotli/shared';
import { isApiStoppedError, type ResolverErrorName } from '@dotli/resolver';
import { ERROR_TITLES, HOST_ERRORS } from './errorCopy.js';
import { ManifestRejectedError } from './manifestRejectedError.js';
import { SandboxSilentError } from './watchSandbox.js';

export type Recovery = 'switch-backend' | 'reload' | 'none';

/** Stable identity for a classified failure, independent of its copy. */
export type ErrorKind =
  | 'protocol-fatal'
  | 'protocol-init-failed'
  | 'protocol-version-mismatch'
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
  | 'sandbox-silent'
  | 'unknown';

export type ErrorDescription = {
  kind: ErrorKind;
  title: string;
  message: string;
  recovery: Recovery;
  /** What the visitor can check themselves, listed under "Try". */
  tips: readonly string[];
  /** Purge the protocol iframe's worker caches on reload, for failures a plain reload would boot straight back into. */
  resetProtocol?: boolean;
};

type DescribeErrorParams = {
  /** Gives the backend the page runs, from settings by default. */
  readBackend?: (() => Backend) | undefined;
};

type ClassifyErrorParams = {
  readBackend: () => Backend;
};

// Annotated, so renaming the resolver's error fails to compile here. Only the name survives postMessage.
const NETWORK_SYNC_TIMEOUT: ResolverErrorName = 'NetworkSyncTimeoutError';

const CONNECTIVITY_TIPS = ['Checking your internet connection.'] as const;

const BITSWAP_TIPS = ['Waiting a moment as the app may still be spreading across the network.'] as const;

// A failed shared light client stays dead while another tab keeps it open, so a reload alone rejoins it.
const SHARED_WORKER_TIPS = ['Closing other dot.li tabs, then reloading.', ...CONNECTIVITY_TIPS] as const;

// Deterministic on every reload and transport.
const MAINTAINER_TIPS = ['Contacting the app maintainer.'] as const;

/**
 * Returns the page's description of `error`. Anything a backend switch recovers from is a reachability failure, so it
 * defaults to the connectivity tips unless its branch states its own. Throws only as `readBackend` does.
 */
export function describeError(
  error: unknown,
  { readBackend = getBackend }: DescribeErrorParams = {},
): ErrorDescription {
  const described = classifyError(error, { readBackend });
  return {
    ...described,
    title: described.title ?? ERROR_TITLES.DOMAIN_UNREACHABLE,
    tips: described.tips ?? (described.recovery === 'switch-backend' ? CONNECTIVITY_TIPS : []),
  };
}

/** The name resolves over the Asset Hub RPC and the bytes come from the IPFS gateway. Some networks host both. */
export function getTrustedProviderHosts(): string[] {
  return [...new Set([getAssethubHost(), getIpfsGatewayHost()].filter((host): host is string => host !== undefined))];
}

function classifyError(
  error: unknown,
  { readBackend }: ClassifyErrorParams,
): Omit<ErrorDescription, 'tips' | 'title'> & {
  tips?: readonly string[];
  title?: string;
} {
  const isP2p = hasLightClient(readBackend());
  // A branch that forgets its `kind` is a compile error rather than an unkeyed error page.
  const message = getErrorMessage(error);

  // The app's origin never answered, which a blocker or a filtered network causes, not the network the app is on.
  if (error instanceof SandboxSilentError) {
    return {
      kind: 'sandbox-silent',
      title: ERROR_TITLES.APP_UNUSABLE,
      message: HOST_ERRORS.SANDBOX_SILENT,
      recovery: 'reload',
      tips: ['Allowing dot.li sites in any content or ad blocker.', ...CONNECTIVITY_TIPS],
    };
  }
  // This page and the protocol frame come from different releases. Only a reload brings them back together.
  if (error instanceof ProtocolVersionMismatchError) {
    return {
      kind: 'protocol-version-mismatch',
      title: ERROR_TITLES.HOST_UNAVAILABLE,
      message: HOST_ERRORS.PROTOCOL_UPDATED,
      recovery: 'reload',
      tips: [],
    };
  }
  if (error instanceof ProtocolFatalError) {
    return {
      kind: 'protocol-fatal',
      message: HOST_ERRORS.FATAL_PANIC,
      recovery: 'switch-backend',
    };
  }
  // Specific messages before the broad `ProtocolInitFailedError` branch, which would mask them.
  if (message.includes('chain spec') || message.includes('Chain spec')) {
    return {
      kind: 'chain-spec-rejected',
      message: HOST_ERRORS.CHAIN_SPEC_REJECTED,
      recovery: 'switch-backend',
    };
  }
  if (message.includes('Failed to fetch dynamically imported module')) {
    return {
      kind: 'module-fetch-failed',
      message: HOST_ERRORS.MODULE_FETCH_FAILED,
      recovery: 'reload',
    };
  }
  // A reload or another transport reads the same manifests and reaches the same verdict.
  if (error instanceof ManifestRejectedError) {
    return {
      kind: error.reason === 'unsupported-version' ? 'manifest-unsupported-version' : 'manifest-invalid',
      title: ERROR_TITLES.APP_UNUSABLE,
      message:
        error.reason === 'unsupported-version'
          ? HOST_ERRORS.MANIFEST_UNSUPPORTED_VERSION
          : HOST_ERRORS.MANIFEST_INVALID,
      recovery: 'none',
      tips: MAINTAINER_TIPS,
    };
  }
  if (message.includes('non-IPFS contenthash') || message.includes('Failed to decode contenthash')) {
    return {
      kind: 'contenthash-unsupported',
      message: HOST_ERRORS.CONTENTHASH_UNSUPPORTED,
      recovery: 'none',
    };
  }
  // polkadot-api's `DisjointError`: the follow was torn down with reads in flight. Not the visitor's network, and the
  // light client that lost it survives a plain reload in the protocol iframe, hence the purge.
  if (message.includes('ChainHead disjointed')) {
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
  if (message.includes('No connected peers have the CID') || message.includes('code=-32810')) {
    return {
      kind: 'bitswap-no-peers',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: HOST_ERRORS.BITSWAP_NO_PEERS,
      recovery: 'switch-backend',
      tips: BITSWAP_TIPS,
    };
  }
  // The gateway copy and its `switch-backend` recovery advise the gateway backend, where content comes over HTTPS.
  if (!isP2p && getErrorName(error) === CONTENT_ERRORS.GATEWAY_UNREACHABLE) {
    return {
      kind: 'failed-to-fetch',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: describeGatewayUnreachable(getIpfsGatewayHost()),
      recovery: 'switch-backend',
      tips: getGatewayTips(readBackend()),
    };
  }
  // The CAR body was cut short in transit, a download failure rather than a reachability one.
  if (message.includes('Unexpected end of data')) {
    return {
      kind: 'unexpected-end-of-data',
      title: ERROR_TITLES.CONTENT_UNAVAILABLE,
      message: HOST_ERRORS.ARCHIVE_TRUNCATED,
      recovery: 'switch-backend',
      tips: getTruncatedTips(readBackend()),
    };
  }
  // Fresh fetch and cache hit are one fault, since purging the cache would re-fetch the same archive.
  if (message.includes('missing index.html')) {
    return {
      kind: 'archive-missing-index',
      title: ERROR_TITLES.APP_UNUSABLE,
      message: HOST_ERRORS.ARCHIVE_NO_INDEX,
      recovery: 'none',
      tips: MAINTAINER_TIPS,
    };
  }
  if (message.includes('did not signal ready')) {
    return {
      kind: 'sw-timed-out',
      message: HOST_ERRORS.SW_TIMED_OUT,
      recovery: 'switch-backend',
    };
  }
  // The worker booted but could not sync in time, unlike a SharedWorker that never started.
  if (message.includes('did not complete')) {
    return {
      kind: 'sw-sync-timeout',
      message: HOST_ERRORS.SW_SYNC_TIMEOUT,
      recovery: 'switch-backend',
    };
  }
  if (error instanceof Error && error.name === NETWORK_SYNC_TIMEOUT && isP2p && message.includes('Asset Hub')) {
    return {
      kind: 'hub-sync-timeout',
      message: HOST_ERRORS.HUB_SYNC_TIMEOUT,
      recovery: 'switch-backend',
    };
  }
  if (message.includes('worker init timed out')) {
    return {
      kind: 'worker-init-timeout',
      title: ERROR_TITLES.HOST_UNAVAILABLE,
      message: HOST_ERRORS.WORKER_INIT_TIMEOUT,
      recovery: 'switch-backend',
      tips: [],
      resetProtocol: true,
    };
  }
  if (error instanceof ProtocolInitFailedError) {
    return {
      kind: 'protocol-init-failed',
      message: HOST_ERRORS.SW_FAILED_TO_START,
      recovery: 'switch-backend',
      ...(hasSharedWorker(readBackend()) ? { tips: SHARED_WORKER_TIPS } : {}),
    };
  }
  if (message.includes('timed out') || message.includes('Timed out')) {
    return {
      kind: isP2p ? 'light-client-timeout' : 'rpc-timeout',
      message: isP2p ? HOST_ERRORS.LIGHT_CLIENT_TIMEOUT : HOST_ERRORS.RPC_TIMEOUT,
      recovery: 'switch-backend',
    };
  }
  // The chain halted, and so did its one retry. Unlike `chainhead-disjointed`, the next connect rebuilds the chain,
  // so a plain reload needs no purge.
  if (isChainHaltedRpcError(error) || isApiStoppedError(error)) {
    return {
      kind: 'chain-halted',
      message: HOST_ERRORS.NETWORK_DROPPED,
      recovery: 'switch-backend',
      tips: [],
    };
  }
  return { kind: 'unknown', message, recovery: 'switch-backend' };
}

/** The first entry, since the gateway backend dials the list in order. */
function getAssethubHost(): string | undefined {
  return getEndpointHost(getActiveServicesConfig().assethub.rpcs.at(0));
}

function getIpfsGatewayHost(): string | undefined {
  return getEndpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0));
}

// Quotes the Settings label verbatim, and names the backend this one fails over to.
function getSwitchTransportTip(backend: Backend): string {
  return `Switching Network transport to "${BACKEND_FACTS[BACKEND_FACTS[backend].failover].label}" in Settings.`;
}

// A failing provider is more often its own problem than the visitor's connection, so switching comes first.
function getGatewayTips(backend: Backend): readonly string[] {
  return [getSwitchTransportTip(backend), 'Checking your internet connection.'];
}

// A short body is rarely a flaky link. The repeatable cause is an incompletely pinned archive only the publisher fixes.
function getTruncatedTips(backend: Backend): readonly string[] {
  return [getSwitchTransportTip(backend), 'Contacting the app maintainer if this keeps happening.'];
}
