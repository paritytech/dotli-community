// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A site's transaction on Asset Hub: one chain client per session, which decodes the site's call for the review and
 * builds that decode into its signed transaction, filling every extension, and never submits it. The chain client loads
 * on first open and the extension fillers on first build, so the shell's eager path never carries them.
 */

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type * as TxFillers from '@polkadot-api/signers-common';
import type * as PolkadotApi from 'polkadot-api';
import type { TxCreator } from 'polkadot-api';
import { displayCall, type DisplayCall } from './site-call.js';

/** How long a decode waits for the chain before it counts as unreachable. */
const DECODE_DEADLINE_MS = 30_000;

/** papi's message for call data its runtime cannot decode. */
const INVALID_CALL_DATA = 'createTx: invalid call data';

type SiteChainErrorKind = 'unreachable' | 'undecodable' | 'mismatch';

/**
 * The chain could not be reached in time, the call does not decode on it, or the window's network has another Asset
 * Hub than the one asked for.
 */
export class SiteChainError extends Error {
  override name = 'SiteChainError';
  readonly kind: SiteChainErrorKind;

  constructor(kind: SiteChainErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}

/**
 * A call decoded on Asset Hub: what the review shows, and the transaction of that same call. papi builds it from the
 * decoded call, so a runtime the shown call no longer fits refuses it rather than signing another call.
 */
export interface SiteDecodedCall {
  display: DisplayCall;
  transaction: { create(creator: TxCreator): Promise<Uint8Array> };
}

export interface SiteChainSession {
  /** Decodes a call for the review. Rejects with `SiteChainError`. */
  decode(call: Uint8Array): Promise<SiteDecodedCall>;
  /**
   * Builds the signed transaction of a call this session decoded, without decoding it again. papi fills every
   * extension for the account of `publicKey`, with its default mortality, and `creator` signs. Resolves with the
   * transaction's bytes and never broadcasts it. Rejects with what `creator` rejects with, or with the chain's error or
   * the fillers' load error.
   */
  create(call: SiteDecodedCall, creator: TxCreator, publicKey: Uint8Array): Promise<Uint8Array>;
  /** Ends the session's chain client. */
  close(): void;
}

export interface SiteChain {
  /**
   * Opens a session on the Asset Hub of `genesis`, the genesis the site asked for. Rejects with `SiteChainError`:
   * `mismatch` when the window's network has another Asset Hub, `unreachable` when the chain is not reachable.
   */
  open(genesis: string): Promise<SiteChainSession>;
}

export interface SiteChainDeps {
  /** The genesis of the window's network's Asset Hub. */
  genesis: () => string;
  /** The provider of the Asset Hub of `genesis`, or `null` when the backend cannot reach it. */
  provider: (genesis: string) => JsonRpcProvider | null;
  loadApi: () => Promise<typeof PolkadotApi>;
  /** Resolves with papi's extension fillers, and rejects with the load error when their chunk does not load. */
  loadFillers: () => Promise<Pick<typeof TxFillers, 'withNonce' | 'withCommonExtensions'>>;
  /** The signal that bounds one decode. */
  deadline?: () => AbortSignal;
}

function isInvalidCallData(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CALL_DATA;
}

/** Asset Hub for the session window, one chain client per session. */
export function createSiteChain(deps: SiteChainDeps): SiteChain {
  const deadline = deps.deadline ?? (() => AbortSignal.timeout(DECODE_DEADLINE_MS));
  return {
    async open(genesis) {
      if (genesis.toLowerCase() !== deps.genesis().toLowerCase()) {
        throw new SiteChainError('mismatch', "The window's network has another Asset Hub than the request's");
      }
      const provider = deps.provider(genesis);
      if (provider === null) {
        throw new SiteChainError('unreachable', 'Asset Hub is not reachable on this chain backend');
      }
      let api: typeof PolkadotApi;
      try {
        api = await deps.loadApi();
      } catch (error) {
        throw new SiteChainError('unreachable', 'The chain client did not load', { cause: error });
      }
      let client: PolkadotApi.PolkadotClient;
      try {
        client = api.createClient(provider);
      } catch (error) {
        // The provider connects as the client is created, and may fail to.
        throw new SiteChainError('unreachable', 'The chain client could not be created', { cause: error });
      }
      const unsafe = client.getUnsafeApi();
      const decodeCall = async (call: Uint8Array) => {
        try {
          return await unsafe.txFromCallData(call, { signal: deadline() });
        } catch (error) {
          throw isInvalidCallData(error)
            ? new SiteChainError('undecodable', 'The call does not decode on Asset Hub', { cause: error })
            : new SiteChainError('unreachable', 'Asset Hub did not answer the decode', { cause: error });
        }
      };
      let closed = false;
      return {
        decode: async call => {
          const transaction = await decodeCall(call);
          return { display: displayCall(transaction.decodedCall), transaction };
        },
        create: async (call, creator, publicKey) => {
          const { withNonce, withCommonExtensions } = await deps.loadFillers();
          return call.transaction.create(withNonce(publicKey)(withCommonExtensions(creator)));
        },
        close() {
          if (!closed) {
            closed = true;
            client.destroy();
          }
        },
      };
    },
  };
}
