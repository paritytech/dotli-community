// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type * as PolkadotApi from 'polkadot-api';
import type { TxCreator, TxEvent, TxInBestBlock } from 'polkadot-api';
import { must } from '@dotli/shared/testing';
import { createSiteChain, SiteChainError, submitEvents, type SiteSubmitEvent, type TxEvents } from './site-chain.js';

const TX_HASH = `0x${'aa'.repeat(32)}`;
const BLOCK_HASH = `0x${'bb'.repeat(32)}`;

class FakeInvalidTxError extends Error {}

const isInvalid = (error: unknown): boolean => error instanceof FakeInvalidTxError;

type Step = { event: TxEvent } | { error: unknown } | { complete: true };

type Observer = Parameters<TxEvents['subscribe']>[0];

/** A watch that plays its steps as soon as it is subscribed to, as papi does for events it already holds. */
function scriptedWatch(steps: Step[]): TxEvents & { unsubscribed: () => number } {
  let unsubscribed = 0;
  return {
    subscribe(observer) {
      for (const step of steps) {
        if ('event' in step) {
          observer.next(step.event);
        } else if ('error' in step) {
          observer.error(step.error);
        } else {
          observer.complete();
        }
      }
      return {
        unsubscribe() {
          unsubscribed += 1;
        },
      };
    },
    unsubscribed: () => unsubscribed,
  };
}

/** A watch the test drives one event at a time. */
function manualWatch(): TxEvents & { emit: (event: TxEvent) => void; unsubscribed: () => number } {
  let observer: Observer | null = null;
  let unsubscribed = 0;
  return {
    subscribe(next) {
      observer = next;
      return {
        unsubscribe() {
          unsubscribed += 1;
        },
      };
    },
    emit: event => {
      must(observer, 'a subscribed observer').next(event);
    },
    unsubscribed: () => unsubscribed,
  };
}

function inBestBlock(dispatch: Pick<TxInBestBlock, 'ok' | 'dispatchError'>): TxEvent {
  return {
    type: 'inBestBlock',
    txHash: TX_HASH,
    events: [],
    block: { hash: BLOCK_HASH, number: 7, index: 1 },
    ...dispatch,
  } as TxInBestBlock;
}

const created: TxEvent = { type: 'created', txHash: TX_HASH };
const broadcasted: TxEvent = { type: 'broadcasted', txHash: TX_HASH };

const CALL = new Uint8Array([0x0a, 0x03]);

/** The Asset Hub of the window's network. */
const GENESIS = `0x${'ab'.repeat(32)}`;

// The chain module only hands the provider to the client, which the fake ignores.
const PROVIDER = (() => undefined) as unknown as JsonRpcProvider;

/**
 * A chain client module whose decode runs `decode` with the decode's signal, and whose client creation throws
 * `createFails` when given. Records each decode and each client it destroys.
 */
function fakeApi(options: { decode?: (signal: AbortSignal) => Promise<unknown>; createFails?: Error }) {
  let decodes = 0;
  let destroyed = 0;
  const api = {
    InvalidTxError: FakeInvalidTxError,
    createClient: () => {
      if (options.createFails !== undefined) {
        throw options.createFails;
      }
      return {
        getUnsafeApi: () => ({
          txFromCallData: (_call: Uint8Array, { signal }: { signal: AbortSignal }) => {
            decodes += 1;
            return (options.decode ?? (() => Promise.reject(new Error('The test decodes nothing'))))(signal);
          },
        }),
        destroy: () => {
          destroyed += 1;
        },
      };
    },
  } as unknown as typeof PolkadotApi;
  return { loadApi: () => Promise.resolve(api), decodes: () => decodes, destroyed: () => destroyed };
}

async function collect(events: AsyncIterable<SiteSubmitEvent>): Promise<SiteSubmitEvent[]> {
  const seen: SiteSubmitEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

describe('submitEvents', () => {
  it('As a window, I watch a transaction reach a best block and the stream ends there', async () => {
    // Given a watch that broadcasts the transaction, finds it in a best block and then finalizes it
    const watch = scriptedWatch([
      { event: created },
      { event: broadcasted },
      { event: inBestBlock({ ok: true }) },
      { event: { ...inBestBlock({ ok: true }), type: 'finalized' } as TxEvent },
    ]);

    // When the window reads the stream
    const seen = await collect(submitEvents(watch, isInvalid));

    // Then it sees the submission and the inclusion only, and the watch is closed
    expect(seen).toEqual([
      { kind: 'submitted', txHash: TX_HASH },
      { kind: 'included', txHash: TX_HASH, blockHash: BLOCK_HASH, ok: true },
    ]);
    expect(watch.unsubscribed()).toBe(1);
  });

  it('As a window, I watch a transaction fail its dispatch and get the error path as text', async () => {
    // Given a watch whose best block holds the transaction with a module error
    const dispatchError = {
      type: 'Module',
      value: { type: 'Balances', value: { type: 'InsufficientBalance', value: undefined } },
    };
    const watch = scriptedWatch([
      { event: created },
      { event: broadcasted },
      { event: inBestBlock({ ok: false, dispatchError }) },
    ]);

    // When the window reads the stream
    const seen = await collect(submitEvents(watch, isInvalid));

    // Then the inclusion carries the error's enum path
    expect(seen).toEqual([
      { kind: 'submitted', txHash: TX_HASH },
      {
        kind: 'included',
        txHash: TX_HASH,
        blockHash: BLOCK_HASH,
        ok: false,
        error: 'Module.Balances.InsufficientBalance',
      },
    ]);
  });

  it('As a window, I submit a transaction the chain refuses before broadcast and see it invalid', async () => {
    // Given a watch that creates the transaction and then fails with an invalid transaction error
    const invalid = new FakeInvalidTxError('Stale');
    const watch = scriptedWatch([{ event: created }, { error: invalid }]);

    // When the window reads the stream
    const seen = await collect(submitEvents(watch, isInvalid));

    // Then the stream ends with the refusal, which carries the chain's error, and nothing was submitted
    expect(seen).toEqual([{ kind: 'invalid', error: invalid }]);
  });

  it('As a window, I lose the watch after broadcast and see the transaction lost', async () => {
    // Given a watch that broadcasts and then fails for another reason
    const failure = new Error('chainHead stopped');
    const watch = scriptedWatch([{ event: created }, { event: broadcasted }, { error: failure }]);

    // When the window reads the stream
    const seen = await collect(submitEvents(watch, isInvalid));

    // Then the submission is followed by the loss, which carries the watch's error
    expect(seen).toEqual([
      { kind: 'submitted', txHash: TX_HASH },
      { kind: 'lost', error: failure },
    ]);
  });

  it("As a window, I submit a transaction the creator rejects and get the creator's error unchanged", async () => {
    // Given a watch that fails before the transaction was created
    const rejection = new Error('Rejected on the phone');
    const watch = scriptedWatch([{ error: rejection }]);

    // When the window reads the stream
    const reading = collect(submitEvents(watch, isInvalid));

    // Then the stream throws the creator's own error
    await expect(reading).rejects.toBe(rejection);
  });

  it('As a window, I stop reading while waiting and the watch is closed at once', async () => {
    // Given a stream that has reported the submission and waits for the next event
    const watch = manualWatch();
    const iterator = submitEvents(watch, isInvalid)[Symbol.asyncIterator]();
    const first = iterator.next();
    watch.emit(created);
    watch.emit(broadcasted);
    await first;
    const pending = iterator.next();

    // When the window stops reading
    await iterator.return?.();

    // Then the waiting read ends and the watch is closed
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(watch.unsubscribed()).toBe(1);
  });

  it('As a window, I see a transaction lost when its watch completes before a best block', async () => {
    // Given a watch that broadcasts the transaction and then completes
    const watch = scriptedWatch([{ event: created }, { event: broadcasted }, { complete: true }]);

    // When the window reads the stream
    const seen = await collect(submitEvents(watch, isInvalid));

    // Then the submission is followed by the loss
    expect(seen.map(event => event.kind)).toEqual(['submitted', 'lost']);
  });
});

describe('createSiteChain', () => {
  it("As a window, I open the Asset Hub the request was checked against and it is my network's", async () => {
    // Given a chain on the window's network, and the request's genesis in another case
    const requested = `0x${'AB'.repeat(32)}`;
    const asked: string[] = [];
    const api = fakeApi({});
    const chain = createSiteChain({
      genesis: () => GENESIS,
      provider: genesis => {
        asked.push(genesis);
        return PROVIDER;
      },
      loadApi: api.loadApi,
    });

    // When the window opens the request's Asset Hub
    const session = await chain.open(requested);

    // Then it opened a session, on a provider for the request's chain
    expect(session).toHaveProperty('decode');
    expect(asked).toEqual([requested]);
  });

  it("As a window, I open an Asset Hub other than my network's and it is refused before anything connects", async () => {
    // Given a chain on the window's network
    const provider = vi.fn(() => PROVIDER);
    const loadApi = vi.fn(() => Promise.reject(new Error('The chain client must not load')));
    const chain = createSiteChain({ genesis: () => GENESIS, provider, loadApi });

    // When the window opens another network's Asset Hub
    const opening = chain.open(`0x${'cd'.repeat(32)}`);

    // Then it rejects as a mismatch, with no provider asked for and no chain client loaded
    await expect(opening).rejects.toBeInstanceOf(SiteChainError);
    await expect(opening).rejects.toMatchObject({ kind: 'mismatch' });
    expect(provider).not.toHaveBeenCalled();
    expect(loadApi).not.toHaveBeenCalled();
  });

  it('As a window, I open the chain without a provider and it is unreachable', async () => {
    // Given a chain whose provider is missing
    const loadApi = vi.fn(() => Promise.reject(new Error('The chain client must not load')));
    const chain = createSiteChain({ genesis: () => GENESIS, provider: () => null, loadApi });

    // When the window opens it
    const opening = chain.open(GENESIS);

    // Then it rejects as unreachable without loading the chain client
    await expect(opening).rejects.toBeInstanceOf(SiteChainError);
    await expect(opening).rejects.toMatchObject({ kind: 'unreachable' });
    expect(loadApi).not.toHaveBeenCalled();
  });

  it('As a window, I open the chain while its client cannot be created and it is unreachable', async () => {
    // Given a chain client module whose client creation throws
    const failure = new Error('The provider could not be acquired');
    const { loadApi } = fakeApi({ createFails: failure });
    const chain = createSiteChain({ genesis: () => GENESIS, provider: () => PROVIDER, loadApi });

    // When the window opens it
    const opening = chain.open(GENESIS);

    // Then it rejects as unreachable, with the creation's error as its cause
    await expect(opening).rejects.toBeInstanceOf(SiteChainError);
    await expect(opening).rejects.toMatchObject({ kind: 'unreachable', cause: failure });
  });

  it('As a window, I decode a call papi cannot read and it is undecodable', async () => {
    // Given a chain whose decode fails with papi's invalid call data error
    const { loadApi } = fakeApi({ decode: () => Promise.reject(new Error('createTx: invalid call data')) });
    const session = await createSiteChain({ genesis: () => GENESIS, provider: () => PROVIDER, loadApi }).open(GENESIS);

    // When the window decodes the call
    const decoding = session.decode(CALL);

    // Then it rejects as undecodable
    await expect(decoding).rejects.toBeInstanceOf(SiteChainError);
    await expect(decoding).rejects.toMatchObject({ kind: 'undecodable' });
  });

  it('As a window, I decode a call past its deadline and the chain is unreachable', async () => {
    // Given a chain whose decode waits until its signal aborts, and a deadline the test aborts
    const deadline = new AbortController();
    const { loadApi } = fakeApi({
      decode: signal =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('The decode was aborted', { cause: signal.reason }));
          });
        }),
    });
    const session = await createSiteChain({
      genesis: () => GENESIS,
      provider: () => PROVIDER,
      loadApi,
      deadline: () => deadline.signal,
    }).open(GENESIS);
    const decoding = session.decode(CALL);

    // When the deadline passes
    deadline.abort(new DOMException('The decode timed out', 'TimeoutError'));

    // Then the decode rejects as unreachable
    await expect(decoding).rejects.toBeInstanceOf(SiteChainError);
    await expect(decoding).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('As a window, I submit the call I decoded for the review as its own transaction, with no second decode', async () => {
    // Given a session whose decode hands out a transaction that is broadcast and included
    const creators: TxCreator[] = [];
    const transaction = {
      decodedCall: { type: 'Balances', value: { type: 'transfer_keep_alive', value: { value: 1n } } },
      createSubmitAndWatch: (creator: TxCreator) => {
        creators.push(creator);
        return scriptedWatch([{ event: created }, { event: broadcasted }, { event: inBestBlock({ ok: true }) }]);
      },
    };
    const api = fakeApi({ decode: () => Promise.resolve(transaction) });
    const session = await createSiteChain({
      genesis: () => GENESIS,
      provider: () => PROVIDER,
      loadApi: api.loadApi,
    }).open(GENESIS);
    const decoded = await session.decode(CALL);
    const creator: TxCreator = () => Promise.reject(new Error('The fake watch builds nothing'));

    // When the window submits the decoded call
    const seen = await collect(session.submit(decoded, creator));

    // Then the review got the call to show, its own transaction was submitted with the creator, and the call was
    // decoded once
    expect(decoded.display).toEqual({ name: 'Balances.transfer_keep_alive', args: [{ name: 'value', value: '1' }] });
    expect(creators).toEqual([creator]);
    expect(seen.map(event => event.kind)).toEqual(['submitted', 'included']);
    expect(api.decodes()).toBe(1);
  });

  it('As a window, I close a session twice and its chain client ends once', async () => {
    // Given an open session
    const api = fakeApi({});
    const session = await createSiteChain({
      genesis: () => GENESIS,
      provider: () => PROVIDER,
      loadApi: api.loadApi,
    }).open(GENESIS);

    // When the window closes it twice
    session.close();
    session.close();

    // Then the chain client was destroyed once
    expect(api.destroyed()).toBe(1);
  });
});
