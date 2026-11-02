// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type * as PolkadotApi from 'polkadot-api';
import type { TxCreator } from 'polkadot-api';
import { createSiteChain, SiteChainError, type SiteChainParams } from './createSiteChain.js';

type Params = {
  /** Runs each decode with the decode's signal, rejecting by default. */
  decode?: (signal: AbortSignal) => Promise<unknown>;
  /** What creating the client throws, when given. */
  createFails?: Error;
};

const CALL = new Uint8Array([0x0a, 0x03]);

/** The Asset Hub of the window's network. */
const GENESIS = `0x${'ab'.repeat(32)}`;

/** The key of the account the site named. */
const SITE_KEY = new Uint8Array(32).fill(0x22);

// A stand-in provider, which the fake client never calls.
const PROVIDER = (() => undefined) as unknown as JsonRpcProvider;

/** Fillers for a test that builds no transaction. */
function rejectFillers(): Promise<never> {
  return Promise.reject(new Error('The test builds no transaction'));
}

/** A chain client module that records each decode and each client it destroys. */
function createFakeApi({ decode, createFails }: Params) {
  let decodes = 0;
  let destroyed = 0;
  // The fake is a partial chain client module, enough for the calls under test.
  const api = {
    createClient() {
      if (createFails !== undefined) {
        throw createFails;
      }
      return {
        getUnsafeApi: () => ({
          txFromCallData(_call: Uint8Array, { signal }: { signal: AbortSignal }) {
            decodes += 1;
            return (decode ?? (() => Promise.reject(new Error('The test decodes nothing'))))(signal);
          },
        }),
        destroy() {
          destroyed += 1;
        },
      };
    },
  } as unknown as typeof PolkadotApi;
  return { loadApi: () => Promise.resolve(api), countDecodes: () => decodes, countDestroyed: () => destroyed };
}

describe('site chain', () => {
  it("As a site, I name my network's Asset Hub in another case and the window opens it on a provider for that chain", async () => {
    // Given a chain on the window's network, and the request's genesis in another case
    const requested = `0x${'AB'.repeat(32)}`;
    const asked: string[] = [];
    const api = createFakeApi({});
    const chain = createSiteChain({
      genesis: () => GENESIS,
      provider(genesis) {
        asked.push(genesis);
        return PROVIDER;
      },
      loadApi: api.loadApi,
      loadFillers: rejectFillers,
    });

    // When the window opens the request's Asset Hub
    const session = await chain.open(requested);

    // Then it opened a session, on a provider for the request's chain
    expect(session).toHaveProperty('decode');
    expect(asked).toEqual([requested]);
  });

  it("As a site, I name an Asset Hub other than the window's network's and it is refused before anything connects", async () => {
    // Given a chain on the window's network
    const provider = vi.fn(() => PROVIDER);
    const loadApi = vi.fn(() => Promise.reject(new Error('The chain client must not load')));
    const chain = createSiteChain({ genesis: () => GENESIS, provider, loadApi, loadFillers: rejectFillers });

    // When the window opens another network's Asset Hub
    const opening = chain.open(`0x${'cd'.repeat(32)}`);

    // Then it rejects as a mismatch, with no provider asked for and no chain client loaded
    await expect(opening).rejects.toBeInstanceOf(SiteChainError);
    await expect(opening).rejects.toMatchObject({ kind: 'mismatch' });
    expect(provider).not.toHaveBeenCalled();
    expect(loadApi).not.toHaveBeenCalled();
  });

  it('As a user whose backend has no provider for the chain, I sign a transaction and the chain is unreachable', async () => {
    // Given a chain whose provider is missing
    const loadApi = vi.fn(() => Promise.reject(new Error('The chain client must not load')));
    const chain = createSiteChain({
      genesis: () => GENESIS,
      provider: () => null,
      loadApi,
      loadFillers: rejectFillers,
    });

    // When the window opens it
    const opening = chain.open(GENESIS);

    // Then it rejects as unreachable without loading the chain client
    await expect(opening).rejects.toBeInstanceOf(SiteChainError);
    await expect(opening).rejects.toMatchObject({ kind: 'unreachable' });
    expect(loadApi).not.toHaveBeenCalled();
  });

  it('As a user whose chain client cannot be created, I sign a transaction and the chain is unreachable', async () => {
    // Given a chain client module whose client creation throws
    const failure = new Error('The provider could not be acquired');
    const { loadApi } = createFakeApi({ createFails: failure });
    const chain = createSiteChain({
      genesis: () => GENESIS,
      provider: () => PROVIDER,
      loadApi,
      loadFillers: rejectFillers,
    });

    // When the window opens it
    const opening = chain.open(GENESIS);

    // Then it rejects as unreachable, with the creation's error as its cause
    await expect(opening).rejects.toBeInstanceOf(SiteChainError);
    await expect(opening).rejects.toMatchObject({ kind: 'unreachable', cause: failure });
  });

  it('As a site, I send a call papi cannot read and it is undecodable', async () => {
    // Given a chain whose decode fails with papi's invalid call data error
    const { loadApi } = createFakeApi({ decode: () => Promise.reject(new Error('createTx: invalid call data')) });
    const session = await createSiteChain({
      genesis: () => GENESIS,
      provider: () => PROVIDER,
      loadApi,
      loadFillers: rejectFillers,
    }).open(GENESIS);

    // When the window decodes the call
    const decoding = session.decode(CALL);

    // Then it rejects as undecodable
    await expect(decoding).rejects.toBeInstanceOf(SiteChainError);
    await expect(decoding).rejects.toMatchObject({ kind: 'undecodable' });
  });

  it('As a user, I wait on a decode past its deadline and the chain is unreachable', async () => {
    // Given a chain whose decode waits until its signal aborts, and a deadline the test aborts
    const deadline = new AbortController();
    const { loadApi } = createFakeApi({
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
      loadFillers: rejectFillers,
      deadline: () => deadline.signal,
    }).open(GENESIS);
    const decoding = session.decode(CALL);

    // When the deadline passes
    deadline.abort(new DOMException('The decode timed out', 'TimeoutError'));

    // Then the decode rejects as unreachable
    await expect(decoding).rejects.toBeInstanceOf(SiteChainError);
    await expect(decoding).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('As a site, I send a call and the window builds it into a signed transaction and sends nothing', async () => {
    // Given a session whose decode hands out a transaction that builds into fixed bytes, and fillers that record the
    // public key and hand the creator back unchanged
    const signed = Uint8Array.of(0x45, 0x02, 0x84);
    const creators: TxCreator[] = [];
    const transaction = {
      decodedCall: { type: 'Balances', value: { type: 'transfer_keep_alive', value: { value: 1n } } },
      create(creator: TxCreator) {
        creators.push(creator);
        return Promise.resolve(signed);
      },
    };
    const keys: Uint8Array[] = [];
    const unchanged = (creator: TxCreator): TxCreator => creator;
    // The fake is a partial filler module, enough for the build under test.
    const fillers = {
      withNonce(publicKey: Uint8Array) {
        keys.push(publicKey);
        return unchanged;
      },
      withCommonExtensions: unchanged,
    } as unknown as Awaited<ReturnType<SiteChainParams['loadFillers']>>;
    const api = createFakeApi({ decode: () => Promise.resolve(transaction) });
    const session = await createSiteChain({
      genesis: () => GENESIS,
      provider: () => PROVIDER,
      loadApi: api.loadApi,
      loadFillers: () => Promise.resolve(fillers),
    }).open(GENESIS);
    const decoded = await session.decode(CALL);
    const creator: TxCreator = () => Promise.reject(new Error('The fake transaction signs nothing'));

    // When the window builds the decoded call
    const built = await session.create({ call: decoded, creator, publicKey: SITE_KEY });

    // Then the review got the call to show, its own transaction was built once with the creator for the site's key,
    // the call was decoded once, and the build resolved with the transaction's bytes
    expect(decoded.display).toEqual({ name: 'Balances.transfer_keep_alive', args: [{ name: 'value', value: '1' }] });
    expect(keys).toEqual([SITE_KEY]);
    expect(creators).toEqual([creator]);
    expect(api.countDecodes()).toBe(1);
    expect(built).toBe(signed);
  });

  it('As a user, I end a transaction whose session closes twice and its chain client ends once', async () => {
    // Given an open session
    const api = createFakeApi({});
    const session = await createSiteChain({
      genesis: () => GENESIS,
      provider: () => PROVIDER,
      loadApi: api.loadApi,
      loadFillers: rejectFillers,
    }).open(GENESIS);

    // When the window closes it twice
    session.close();
    session.close();

    // Then the chain client was destroyed once
    expect(api.countDestroyed()).toBe(1);
  });
});
