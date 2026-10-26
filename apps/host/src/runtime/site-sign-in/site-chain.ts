// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A site's transaction on Asset Hub: one chain client per session, which decodes the site's call for the review and
 * submits that decode once, reporting papi's events as the window's own. The chain client loads on first open, so the
 * shell's eager path never carries it.
 */

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type * as PolkadotApi from 'polkadot-api';
import type { TxCreator, TxEvent, TxInBestBlock } from 'polkadot-api';
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

/** What the window hears of a submitted transaction. */
export type SiteSubmitEvent =
  | { kind: 'submitted'; txHash: string }
  | { kind: 'included'; txHash: string; blockHash: string; ok: true }
  | { kind: 'included'; txHash: string; blockHash: string; ok: false; error: string }
  | { kind: 'invalid'; error: unknown }
  | { kind: 'lost'; error: unknown };

/** A transaction's watch, as papi's observable offers it. */
export interface TxEvents {
  subscribe(observer: { next(event: TxEvent): void; error(error: unknown): void; complete(): void }): {
    unsubscribe(): void;
  };
}

/**
 * A call decoded on Asset Hub: what the review shows, and the transaction that submits that same call. papi builds it
 * from the decoded call, so a runtime the shown call no longer fits refuses it rather than signing another call.
 */
export interface SiteDecodedCall {
  display: DisplayCall;
  transaction: { createSubmitAndWatch(creator: TxCreator): TxEvents };
}

export interface SiteChainSession {
  /** Decodes a call for the review. Rejects with `SiteChainError`. */
  decode(call: Uint8Array): Promise<SiteDecodedCall>;
  /**
   * Builds, submits and watches the transaction of a call this session decoded, without decoding it again. Each call
   * submits anew, so call it once per transaction.
   */
  submit(call: SiteDecodedCall, creator: TxCreator): AsyncIterable<SiteSubmitEvent>;
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
  /** The signal that bounds one decode. */
  deadline?: () => AbortSignal;
}

function isEnum(value: unknown): value is { type: string; value: unknown } {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/** The dispatch error's variant, then each nested variant, joined by `.`. */
function dispatchErrorText(error: { type: string; value: unknown }): string {
  const path = [error.type];
  let inner = error.value;
  while (isEnum(inner)) {
    path.push(inner.type);
    inner = inner.value;
  }
  return path.join('.');
}

function included(event: TxInBestBlock): SiteSubmitEvent {
  const { txHash, block } = event;
  return event.ok
    ? { kind: 'included', txHash, blockHash: block.hash, ok: true }
    : { kind: 'included', txHash, blockHash: block.hash, ok: false, error: dispatchErrorText(event.dispatchError) };
}

interface Waiting {
  resolve(result: IteratorResult<SiteSubmitEvent, undefined>): void;
  reject(error: unknown): void;
}

/**
 * Reads a transaction's watch as the window's events, ending at the first best block. An error before `created` is
 * the creator's and is rethrown unchanged. Stopping the iteration unsubscribes at once, even while a read waits, so a
 * transaction cancelled before broadcast is never broadcast.
 */
export function submitEvents(events: TxEvents, isInvalid: (error: unknown) => boolean): AsyncIterable<SiteSubmitEvent> {
  const queue: SiteSubmitEvent[] = [];
  let failure: { error: unknown } | null = null;
  let waiting: Waiting | null = null;
  let subscription: { unsubscribe(): void } | null = null;
  let started = false;
  let ended = false;
  let created = false;

  const settle = (): void => {
    const reader = waiting;
    if (reader === null) {
      return;
    }
    const next = queue.shift();
    if (next !== undefined) {
      waiting = null;
      reader.resolve({ done: false, value: next });
    } else if (failure !== null) {
      waiting = null;
      const { error } = failure;
      failure = null;
      reader.reject(error);
    } else if (ended) {
      waiting = null;
      reader.resolve({ done: true, value: undefined });
    }
  };

  const end = (): void => {
    ended = true;
    const watch = subscription;
    subscription = null;
    watch?.unsubscribe();
  };

  const observer = {
    next(event: TxEvent): void {
      if (ended) {
        return;
      }
      if (event.type === 'created') {
        created = true;
      } else if (event.type === 'broadcasted') {
        queue.push({ kind: 'submitted', txHash: event.txHash });
      } else if (event.type === 'inBestBlock') {
        queue.push(included(event));
        end();
      }
      settle();
    },
    error(error: unknown): void {
      if (ended) {
        return;
      }
      if (!created) {
        failure = { error };
      } else {
        queue.push(isInvalid(error) ? { kind: 'invalid', error } : { kind: 'lost', error });
      }
      end();
      settle();
    },
    complete(): void {
      if (ended) {
        return;
      }
      queue.push({ kind: 'lost', error: new Error('The transaction watch ended before a best block') });
      end();
      settle();
    },
  };

  const start = (): void => {
    started = true;
    const watch = events.subscribe(observer);
    // The watch may end while it subscribes, before there was a subscription to close.
    if (ended) {
      watch.unsubscribe();
    } else {
      subscription = watch;
    }
  };

  const iterator: AsyncIterator<SiteSubmitEvent, undefined> = {
    next: () => {
      if (!started && !ended) {
        start();
      }
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        settle();
      });
    },
    return: () => {
      end();
      queue.length = 0;
      failure = null;
      settle();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
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
        submit: (call, creator) =>
          submitEvents(call.transaction.createSubmitAndWatch(creator), error => error instanceof api.InvalidTxError),
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
