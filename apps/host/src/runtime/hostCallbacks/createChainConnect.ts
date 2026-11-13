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
import { isRecord, toHex } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { hostChainPool } from './createHostChainPool.js';

type Params = {
  /** The pool the connections lease. The page's host chain pool by default. */
  pool?: ChainPool;
};

/**
 * Connects the core to a chain over one healing lease on the host pool, which answers a request it cannot send itself.
 * Rejects with `CHAIN_PROVIDER_UNAVAILABLE` when the pool has no transport for the chain, as for one the backend in
 * force does not serve.
 */
export function createChainConnect({ pool = hostChainPool }: Params = {}): ChainProvider['connect'] {
  // No list of product chains is checked here, since core-owned Bulletin operations come through this callback too.
  // The pool refuses a chain the backend in force does not serve.
  // eslint-disable-next-line @typescript-eslint/require-await -- async so a refusal rejects the promise, not throws at the call
  async function connect(genesisHash: Uint8Array): Promise<PlatformJsonRpcConnection> {
    const provider = pool.getLocalProvider(toHex(genesisHash), { holder: 'truapi-core' });
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
