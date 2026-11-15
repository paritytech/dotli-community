// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ProtocolFatalError, ProtocolInitFailedError, ProtocolVersionMismatchError } from '@dotli/protocol';
import { getBackend, hasLightClient, hasSharedWorker, type Backend } from '@dotli/config';
import { getErrorMessage, getErrorName, isChainHaltedRpcError } from '@dotli/shared';
import { isApiStoppedError, type ResolverErrorName } from '@dotli/resolver';
import { ERROR_TITLES, HOST_ERRORS } from './errorCopy.js';
import { ManifestRejectedError, type ManifestRejection } from './manifestRejectedError.js';
import { SandboxSilentError } from './watchSandboxLoad.js';

export type Recovery = 'switch-backend' | 'reload' | 'landing';

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
  | 'sw-timed-out'
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

// A required `kind`, so a classifier that forgets it is a compile error rather than an unkeyed error page.
type ClassifiedError = Omit<ErrorDescription, 'tips' | 'title'> & {
  tips?: readonly string[];
  title?: string;
};

/** What a classifier reads of a failure. */
type Failure = {
  error: unknown;
  message: string;
  backend: Backend;
};

type DescribeErrorParams = {
  /** The backend the page runs, from settings by default. */
  backend?: Backend | undefined;
};

// Annotated, so renaming the resolver's error fails to compile here. Only the name survives postMessage.
const NETWORK_SYNC_TIMEOUT: ResolverErrorName = 'NetworkSyncTimeoutError';

const CONNECTIVITY_TIPS = ['Checking your internet connection.'] as const;

// Deterministic on every reload and transport.
const MAINTAINER_TIPS = ['Contacting the app maintainer.'] as const;

const MANIFEST_REJECTIONS = {
  'unsupported-version': {
    kind: 'manifest-unsupported-version',
    message: HOST_ERRORS.MANIFEST_UNSUPPORTED_VERSION,
  },
  invalid: { kind: 'manifest-invalid', message: HOST_ERRORS.MANIFEST_INVALID },
  'missing-root': { kind: 'manifest-invalid', message: HOST_ERRORS.MANIFEST_INVALID },
} satisfies Record<ManifestRejection, Pick<ErrorDescription, 'kind' | 'message'>>;

/**
 * The classifiers in the order they run. The first that knows a failure describes it, so a specific cause comes before a
 * broad match that would mask it.
 */
const CLASSIFIERS: readonly ((failure: Failure) => ClassifiedError | null)[] = [
  // The app's origin never answered, which a blocker or a filtered network causes, not the network the app is on.
  ({ error }) =>
    error instanceof SandboxSilentError
      ? {
          kind: 'sandbox-silent',
          title: ERROR_TITLES.APP_UNUSABLE,
          message: HOST_ERRORS.SANDBOX_SILENT,
          recovery: 'reload',
          tips: ['Allowing dot.li sites in any content or ad blocker.', ...CONNECTIVITY_TIPS],
        }
      : null,
  // This page and the protocol frame come from different releases. Only a reload brings them back together.
  ({ error }) =>
    error instanceof ProtocolVersionMismatchError
      ? {
          kind: 'protocol-version-mismatch',
          title: ERROR_TITLES.HOST_UNAVAILABLE,
          message: HOST_ERRORS.PROTOCOL_UPDATED,
          recovery: 'reload',
        }
      : null,
  ({ error }) =>
    error instanceof ProtocolFatalError
      ? { kind: 'protocol-fatal', message: HOST_ERRORS.FATAL_PANIC, recovery: 'switch-backend' }
      : null,
  ({ message }) =>
    message.includes('chain spec') || message.includes('Chain spec')
      ? { kind: 'chain-spec-rejected', message: HOST_ERRORS.CHAIN_SPEC_REJECTED, recovery: 'switch-backend' }
      : null,
  ({ message }) =>
    message.includes('Failed to fetch dynamically imported module')
      ? { kind: 'module-fetch-failed', message: HOST_ERRORS.MODULE_FETCH_FAILED, recovery: 'reload' }
      : null,
  // A reload or another transport reads the same manifests and reaches the same verdict, so the visitor is offered the
  // landing.
  ({ error }) =>
    error instanceof ManifestRejectedError
      ? {
          ...MANIFEST_REJECTIONS[error.reason],
          title: ERROR_TITLES.APP_UNUSABLE,
          recovery: 'landing',
          tips: MAINTAINER_TIPS,
        }
      : null,
  ({ message }) =>
    message.includes('non-IPFS contenthash') || message.includes('Failed to decode contenthash')
      ? { kind: 'contenthash-unsupported', message: HOST_ERRORS.CONTENTHASH_UNSUPPORTED, recovery: 'landing' }
      : null,
  // polkadot-api's `DisjointError`: the follow was torn down with reads in flight. Not the visitor's network, and the
  // light client that lost it survives a plain reload in the protocol iframe, hence the purge.
  ({ message }) =>
    message.includes('ChainHead disjointed')
      ? {
          kind: 'chainhead-disjointed',
          message: HOST_ERRORS.NETWORK_DROPPED,
          recovery: 'switch-backend',
          tips: [],
          resetProtocol: true,
        }
      : null,
  ({ message }) =>
    message.includes('did not signal ready')
      ? { kind: 'sw-timed-out', message: HOST_ERRORS.SW_TIMED_OUT, recovery: 'switch-backend' }
      : null,
  ({ error, backend }) =>
    getErrorName(error) === NETWORK_SYNC_TIMEOUT && hasLightClient(backend)
      ? { kind: 'hub-sync-timeout', message: HOST_ERRORS.HUB_SYNC_TIMEOUT, recovery: 'switch-backend' }
      : null,
  ({ message }) =>
    message.includes('worker init timed out')
      ? {
          kind: 'worker-init-timeout',
          title: ERROR_TITLES.HOST_UNAVAILABLE,
          message: HOST_ERRORS.WORKER_INIT_TIMEOUT,
          recovery: 'switch-backend',
          tips: [],
          resetProtocol: true,
        }
      : null,
  // A failed shared light client stays dead while another tab keeps it open, so a reload alone rejoins it.
  ({ error, backend }) =>
    error instanceof ProtocolInitFailedError
      ? {
          kind: 'protocol-init-failed',
          message: HOST_ERRORS.SW_FAILED_TO_START,
          recovery: 'switch-backend',
          ...(hasSharedWorker(backend)
            ? { tips: ['Closing other dot.li tabs, then reloading.', ...CONNECTIVITY_TIPS] }
            : {}),
        }
      : null,
  ({ message, backend }) =>
    isTimedOut(message) && hasLightClient(backend)
      ? { kind: 'light-client-timeout', message: HOST_ERRORS.LIGHT_CLIENT_TIMEOUT, recovery: 'switch-backend' }
      : null,
  ({ message }) =>
    isTimedOut(message) ? { kind: 'rpc-timeout', message: HOST_ERRORS.RPC_TIMEOUT, recovery: 'switch-backend' } : null,
  // The chain halted, and so did its one retry. The next connect rebuilds the chain, so a plain reload needs no purge.
  ({ error }) =>
    isChainHaltedRpcError(error) || isApiStoppedError(error)
      ? { kind: 'chain-halted', message: HOST_ERRORS.NETWORK_DROPPED, recovery: 'switch-backend', tips: [] }
      : null,
];

/**
 * Returns the page's description of `error`. Anything a backend switch recovers from is a reachability failure, so it
 * defaults to the connectivity tips unless its classifier states its own.
 */
export function describeError(error: unknown, { backend = getBackend() }: DescribeErrorParams = {}): ErrorDescription {
  const described = classifyError({ error, message: getErrorMessage(error), backend });
  return {
    ...described,
    title: described.title ?? ERROR_TITLES.DOMAIN_UNREACHABLE,
    tips: described.tips ?? (described.recovery === 'switch-backend' ? CONNECTIVITY_TIPS : []),
  };
}

function classifyError(failure: Failure): ClassifiedError {
  for (const classify of CLASSIFIERS) {
    const described = classify(failure);
    if (described !== null) {
      return described;
    }
  }
  return { kind: 'unknown', message: failure.message, recovery: 'switch-backend' };
}

function isTimedOut(message: string): boolean {
  return message.includes('timed out') || message.includes('Timed out');
}
