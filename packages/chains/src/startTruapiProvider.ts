// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The engine under the light client: truapi-provider's embedded smoldot. Each chain comes from its genesis hash through
// truapi-provider's bundled catalog.

import { getErrorMessage } from '@dotli/shared';
import init, { ChainProviderBuilder, setLogLevel, type Connection } from '@parity/truapi-provider';
import wasmUrl from '@parity/truapi-provider/truapi_provider_bg.wasm?url';
import type { ChainLifecycleWatch } from './createChainSyncReporter.js';
import type { SmoldotDb } from './createSmoldotDb.js';

/** What the light client uses of a started truapi-provider. */
export type LightClientEngine = {
  /**
   * Hands the chain its stored database before its first add. Resolves whether there was one, and rejects on a failed
   * read.
   */
  loadDatabase(genesisHash: string): Promise<boolean>;
  /**
   * Adds the chain and opens a JSON-RPC connection to it. Rejects when the chain cannot be added, and with a
   * `LightClientCapError` when the engine already holds as many connections as it allows.
   */
  connect(genesisHash: string): Promise<LightClientConnection>;
  /** Watches the chain's lifecycle snapshots. May throw when the engine offers no watch. */
  lifecycle(genesisHash: string): ChainLifecycleWatch;
};

export type LightClientConnection = Pick<Connection, 'send' | 'close' | 'nextResponse'>;

export type StartEngineParams = {
  /** truapi-provider's log level, `off` for none. */
  logLevel: string;
  /** Read for each chain's first add, and written as it finalizes. */
  store: SmoldotDb | null;
  /** Lets the debug console change the log level. */
  debug: boolean;
};

export type StartEngine = (params: StartEngineParams) => Promise<LightClientEngine>;

// truapi-provider rejects a connect past its connection cap with this text.
const CONNECTION_CAP_TEXT = 'the light client already holds';

/** A connect the engine refused because it already holds as many connections as it allows. */
export class LightClientCapError extends Error {
  override readonly name = 'LightClientCapError';

  constructor(genesisHash: string, cause: unknown) {
    super(`Light client refused chain ${genesisHash} at its connection cap`, { cause });
  }
}

/** truapi-provider's wasm, loaded and built once per light client. */
export async function startTruapiProvider({ logLevel, store, debug }: StartEngineParams): Promise<LightClientEngine> {
  await init({ module_or_path: wasmUrl });
  setLogLevel(logLevel);
  if (debug) {
    Reflect.set(globalThis, '__truapiProvider', { setLogLevel });
  }
  const builder = new ChainProviderBuilder();
  // Over https the browser blocks `ws://` to non-localhost peers as mixed content.
  builder.setConnectionTypes({ unsecure: false });
  if (store !== null) {
    builder.setStorage(store);
  }
  return withConnectionCapError(builder.build());
}

/**
 * Wraps `engine` so that a `connect` rejection that states the wasm's connection cap rejects with `LightClientCapError`.
 * Never throws. Any other rejection passes through unchanged. The wasm states its cap only in a rejection's text, so the
 * mapping happens where the failure leaves the wasm.
 */
export function withConnectionCapError(engine: LightClientEngine): LightClientEngine {
  return {
    loadDatabase: genesisHash => engine.loadDatabase(genesisHash),
    lifecycle: genesisHash => engine.lifecycle(genesisHash),
    async connect(genesisHash) {
      try {
        return await engine.connect(genesisHash);
      } catch (error) {
        if (getErrorMessage(error).includes(CONNECTION_CAP_TEXT)) {
          throw new LightClientCapError(genesisHash, error);
        }
        throw error;
      }
    },
  };
}
