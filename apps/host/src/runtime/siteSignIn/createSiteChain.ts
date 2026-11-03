// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A site's transaction on Asset Hub: one chain client per session, which decodes the site's call for the review and
 * builds that decode into its signed transaction, filling every extension, and never submits it. The chain client loads
 * on first open and the extension fillers start loading as a session opens rather than on the first build, so the
 * shell's eager path never carries them.
 */

import { markHandled } from '@dotli/shared';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type * as TxFillers from '@polkadot-api/signers-common';
import type * as PolkadotApi from 'polkadot-api';
import type { TxCreator } from 'polkadot-api';
import { toDisplayCall, type DisplayCall } from './toDisplayCall.js';

type SiteChainErrorKind = 'unreachable' | 'undecodable' | 'mismatch';

/**
 * A call decoded on Asset Hub: what the review shows, and the transaction of that same call. papi builds it from the
 * decoded call, so a runtime the shown call no longer fits refuses it rather than signing another call.
 */
export type SiteDecodedCall = {
  /** The call as the review shows it. */
  display: DisplayCall;
  /** papi's transaction of the call. */
  transaction: {
    /**
     * Signs the call with `creator` and resolves with the transaction's bytes. Rejects with what `creator` rejects
     * with, or with the chain's error when the runtime no longer fits the call.
     */
    create(creator: TxCreator): Promise<Uint8Array>;
  };
};

/** papi's extension fillers, which a build fills every extension with. */
type TxFillerModule = Pick<typeof TxFillers, 'withNonce' | 'withCommonExtensions'>;

export type SiteChainParams = {
  /** The genesis of the window's network's Asset Hub. */
  genesis: () => string;
  /** The provider of the Asset Hub of `genesis`, or `null` when the backend cannot reach it. */
  provider: (genesis: string) => JsonRpcProvider | null;
  /** Resolves with papi, and rejects with the load error when its chunk does not load. */
  loadApi: () => Promise<typeof PolkadotApi>;
  /** Resolves with papi's extension fillers, and rejects with the load error when their chunk does not load. */
  loadFillers: () => Promise<TxFillerModule>;
  /** The signal that bounds one decode. */
  deadline?: () => AbortSignal;
};

/** Asset Hub for the session window. */
export type SiteChain = ReturnType<typeof createSiteChain>;

/** One session on Asset Hub, over its own chain client. */
export type SiteChainSession = ReturnType<typeof createSiteChainSession>;

type CreateSiteChainSessionParams = Pick<SiteChainParams, 'loadFillers'> &
  Required<Pick<SiteChainParams, 'deadline'>> & {
    /** The session's own chain client, which it destroys on close. */
    client: PolkadotApi.PolkadotClient;
  };

/** What a build signs: a call the session decoded, the creator that signs it, and the signing account's key. */
type CreateTransactionParams = {
  call: SiteDecodedCall;
  creator: TxCreator;
  publicKey: Uint8Array;
};

/** How long a decode waits for the chain before it counts as unreachable. */
const DECODE_DEADLINE_MS = 30_000;

/**
 * papi's message for call data its runtime cannot decode. papi throws a plain `Error` for it, so the message is the
 * only mark that tells it apart.
 */
const INVALID_CALL_DATA = 'createTx: invalid call data';

/** Asset Hub for the session window, one chain client per session. */
export function createSiteChain({
  genesis: getNetworkGenesis,
  provider: getProvider,
  loadApi,
  loadFillers,
  deadline = createDecodeDeadline,
}: SiteChainParams) {
  return {
    /**
     * Opens a session on the Asset Hub of `genesis`, the genesis the site asked for. Rejects with `SiteChainError`:
     * `mismatch` when the window's network has another Asset Hub, `unreachable` when the chain is not reachable.
     */
    async open(genesis: string): Promise<SiteChainSession> {
      if (genesis.toLowerCase() !== getNetworkGenesis().toLowerCase()) {
        throw new SiteChainError('mismatch', "The window's network has another Asset Hub than the request's");
      }
      const provider = getProvider(genesis);
      if (provider === null) {
        throw new SiteChainError('unreachable', 'Asset Hub is not reachable on this chain backend');
      }
      // A failed load is left to the build, which loads again and rejects with that load's error.
      void markHandled(loadFillers());
      let api: typeof PolkadotApi;
      try {
        api = await loadApi();
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
      return createSiteChainSession({ client, deadline, loadFillers });
    },
  };
}

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

/** A session over `client`, which it ends on close. */
function createSiteChainSession({ client, deadline, loadFillers }: CreateSiteChainSessionParams) {
  const unsafe = client.getUnsafeApi();
  let closed = false;

  async function decodeCall(call: Uint8Array) {
    try {
      return await unsafe.txFromCallData(call, { signal: deadline() });
    } catch (error) {
      throw isInvalidCallDataError(error)
        ? new SiteChainError('undecodable', 'The call does not decode on Asset Hub', { cause: error })
        : new SiteChainError('unreachable', 'Asset Hub did not answer the decode', { cause: error });
    }
  }

  return {
    /** Decodes a call for the review. Rejects with `SiteChainError`. */
    async decode(call: Uint8Array): Promise<SiteDecodedCall> {
      const transaction = await decodeCall(call);
      return { display: toDisplayCall(transaction.decodedCall), transaction };
    },
    /**
     * Builds the signed transaction of a call this session decoded, without decoding it again. papi fills every
     * extension for the account of `publicKey`, with its default mortality, and `creator` signs. Resolves with the
     * transaction's bytes and never broadcasts it. Rejects with what `creator` rejects with, or with the chain's error or
     * the fillers' load error.
     */
    async create({ call, creator, publicKey }: CreateTransactionParams): Promise<Uint8Array> {
      const { withNonce, withCommonExtensions } = await loadFillers();
      return call.transaction.create(withNonce(publicKey)(withCommonExtensions(creator)));
    },
    /** Ends the session's chain client. */
    close(): void {
      if (!closed) {
        closed = true;
        client.destroy();
      }
    },
  };
}

function createDecodeDeadline(): AbortSignal {
  return AbortSignal.timeout(DECODE_DEADLINE_MS);
}

/** Whether `error` is papi's failure for call data its runtime cannot decode. */
function isInvalidCallDataError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CALL_DATA;
}
