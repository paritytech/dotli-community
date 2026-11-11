// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Without this callback truapi-server would run its own bundled smoldot beside the protocol frame's,
// ignoring the backend the user selected.
//
// Every core connection rides one healing lease on the host chain pool. The lease takes the rebuilt chain after a
// halt, so the stream stays open through it, and what was queued before the halt is still delivered.

import type { JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import type { ChainPool } from '@dotli/chains';
import { hasLightClient } from '@dotli/config';
import { isRecord, log, toHex } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { hostChainPool, pageSources, type HostChainSources } from './createHostChainPool.js';

type Params = {
  /** The pool the connections lease. The page's host chain pool by default. */
  pool?: ChainPool;
  /** Which backend is in force and which chains it serves. The page's sources by default, each one apart. */
  sources?: Partial<Pick<HostChainSources, 'backend' | 'isRemoteChainConnectable' | 'isRpcChainSupported'>>;
};

type CreateConnectionParams = {
  genesisHash: string;
  pool: ChainPool;
};

/** Which chains the backend in force serves, and its name in the log. */
type BackendSupport = {
  isSupported: (genesisHash: string) => boolean;
  backend: string;
};

/**
 * Connects the core to a chain over the host pool. Throws when the backend in force does not serve the chain, before
 * any transport is built, or when the pool has no transport for it.
 */
export function createChainConnect({ pool = hostChainPool, sources = {} }: Params = {}): ChainProvider['connect'] {
  const {
    backend: backendInForce = pageSources.backend,
    isRemoteChainConnectable: isRemoteSupported = pageSources.isRemoteChainConnectable,
    isRpcChainSupported: isRpcSupported = pageSources.isRpcChainSupported,
  } = sources;

  function getBackendSupport(): BackendSupport {
    return hasLightClient(backendInForce())
      ? { isSupported: isRemoteSupported, backend: 'smoldot' }
      : { isSupported: isRpcSupported, backend: 'RPC' };
  }

  function connect(genesisHashBytes: Uint8Array): ReturnType<ChainProvider['connect']> {
    const genesisHash = toHex(genesisHashBytes);
    // Core-owned Bulletin operations also come through here, so every chain the backend serves is let through.
    const { isSupported, backend } = getBackendSupport();
    if (!isSupported(genesisHash)) {
      log.warn(`[dot.li truapi-chain] ${backend} backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported ${backend} chain: ${genesisHash}`);
    }
    return Promise.resolve(createConnection({ genesisHash, pool }));
  }

  return connect;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest<unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const id = value['id'];
  return (
    value['jsonrpc'] === '2.0' &&
    typeof value['method'] === 'string' &&
    (id === undefined || id === null || typeof id === 'string' || typeof id === 'number')
  );
}

/** Takes one healing lease on the chain, which answers a request it cannot send itself. */
function createConnection({ genesisHash, pool }: CreateConnectionParams): PlatformJsonRpcConnection {
  const provider = pool.getLocalProvider(genesisHash, { holder: 'truapi-core' });
  if (!provider) {
    throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
  }
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const lease = provider(deliver);

  function deliver(message: unknown): void {
    if (closed) {
      return;
    }
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  }

  // A call, so the check after the drain isn't narrowed by earlier ones.
  function isClosed(): boolean {
    return closed;
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    lease.disconnect();
    wake?.();
    wake = null;
  }

  return {
    send(request: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request);
      } catch (error) {
        throw new Error(ERRORS.INVALID_JSON_RPC_REQUEST, { cause: error });
      }
      if (!isJsonRpcRequest(parsed)) {
        throw new Error(ERRORS.INVALID_JSON_RPC_REQUEST);
      }
      if (closed) {
        return;
      }
      lease.send(parsed);
    },
    async *responses(): AsyncIterable<string> {
      try {
        for (;;) {
          while (!isClosed() && queue.length > 0) {
            const response = queue.shift();
            if (response !== undefined) {
              yield response;
            }
          }
          if (isClosed()) {
            break;
          }
          await new Promise<void>(resolve => {
            wake = resolve;
          });
        }
      } finally {
        close();
      }
    },
    close,
  };
}
