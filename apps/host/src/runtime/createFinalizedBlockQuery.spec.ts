// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import { createManualTimers } from '@dotli/shared/testing';
import type { RemoteChainProvider } from '@dotli/protocol';
import { bindReports } from '../testing/bindReports.js';
import { createFinalizedBlockQuery, type FinalizedBlockClient } from './createFinalizedBlockQuery.js';

const PEOPLE_GENESIS = getActiveServicesConfig().people.genesis;

/** The host pool's provider for a chain, a connection that sends nowhere. */
function connectChain(): ReturnType<RemoteChainProvider> {
  return { send: vi.fn(), disconnect: vi.fn() };
}

/** A client whose finalized block read settles as `block` does. */
function createReadingClient(block: Promise<{ number: number }>): FinalizedBlockClient & { destroy: Mock<() => void> } {
  return { getFinalizedBlock: () => block, destroy: vi.fn<() => void>() };
}

describe('queryFinalizedBlock', () => {
  it("As a dotli user, I open the diagnostics and a chain's finalized block is read over the host pool", async () => {
    // Given a host pool that serves the chain
    bindReports();
    const client = createReadingClient(Promise.resolve({ number: 42 }));
    const source = {
      provider: vi.fn((_genesisHash: string) => Promise.resolve(connectChain)),
      createClient: vi.fn((_provider: RemoteChainProvider) => Promise.resolve(client)),
    };
    const queryFinalizedBlock = createFinalizedBlockQuery(source);

    // When the block is queried
    const block = await queryFinalizedBlock(PEOPLE_GENESIS);

    // Then the block comes back over the pool's provider and the client is closed
    expect(block).toBe(42);
    expect(source.provider).toHaveBeenCalledWith(PEOPLE_GENESIS);
    expect(source.createClient).toHaveBeenCalledWith(connectChain);
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it('As a dotli user, I open the diagnostics and a chain the host pool cannot serve reads as no block', async () => {
    // Given a host pool that cannot serve the chain
    bindReports();
    const createClient = vi.fn((_provider: RemoteChainProvider) =>
      Promise.resolve(createReadingClient(Promise.resolve({ number: 1 }))),
    );
    const queryFinalizedBlock = createFinalizedBlockQuery({ provider: () => Promise.resolve(null), createClient });

    // When the block is queried
    const block = await queryFinalizedBlock(PEOPLE_GENESIS);

    // Then no block comes back and no client is built
    expect(block).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('As a dotli user, I open the diagnostics and a chain that fails to answer reads as no block with its client closed', async () => {
    // Given a chain whose read fails
    const { captures, counted } = bindReports();
    const client = createReadingClient(Promise.reject(new Error('chainHead follow failed')));
    const queryFinalizedBlock = createFinalizedBlockQuery({
      provider: () => Promise.resolve(connectChain),
      createClient: () => Promise.resolve(client),
    });

    // When the block is queried
    const block = await queryFinalizedBlock(PEOPLE_GENESIS);

    // Then no block comes back, the client is closed and the failure is captured and counted
    expect(block).toBeNull();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'chainHead follow failed' }),
      expect.objectContaining({
        step: 'diagnostics_block',
        tags: { reason: 'Error' },
      }),
    );
    expect(counted('diagnostics.finalized_block')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a dotli maintainer, I see a client that throws as it closes after answering counted once and as an error', async () => {
    // Given a chain that answers, on a client whose close throws
    const { captures, counted } = bindReports();
    const client = createReadingClient(Promise.resolve({ number: 42 }));
    client.destroy.mockImplementation(() => {
      throw new Error('client would not close');
    });
    const queryFinalizedBlock = createFinalizedBlockQuery({
      provider: () => Promise.resolve(connectChain),
      createClient: () => Promise.resolve(client),
    });

    // When the block is queried
    await queryFinalizedBlock(PEOPLE_GENESIS);

    // Then the query is counted once, for the close that failed
    expect(counted('diagnostics.finalized_block')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I open the diagnostics and an answered finalized block query leaves no timer behind', async () => {
    // Given a chain that answers, over manual timers
    const { counted } = bindReports();
    const timers = createManualTimers();
    const queryFinalizedBlock = createFinalizedBlockQuery(
      {
        provider: () => Promise.resolve(connectChain),
        createClient: () => Promise.resolve(createReadingClient(Promise.resolve({ number: 42 }))),
      },
      { timers },
    );

    // When the block is queried
    const block = await queryFinalizedBlock(PEOPLE_GENESIS);

    // Then the block comes back, no timer is pending and the query is counted ok
    expect(block).toBe(42);
    expect(timers.countPending()).toBe(0);
    expect(counted('diagnostics.finalized_block')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a dotli user, I open the diagnostics and a chain that does not answer within the limit reads as no block and leaves one breadcrumb', async () => {
    // Given a chain that never answers, over manual timers
    const { captures, counted } = bindReports();
    const timers = createManualTimers();
    const client = createReadingClient(new Promise<never>(() => undefined));
    const queryFinalizedBlock = createFinalizedBlockQuery(
      {
        provider: () => Promise.resolve(connectChain),
        createClient: () => Promise.resolve(client),
      },
      { timers },
    );

    // When the block is queried and the limit passes
    const query = queryFinalizedBlock(PEOPLE_GENESIS);
    await timers.advance(10_000);
    const block = await query;

    // Then no block comes back, the client is closed and one breadcrumb is left and counted
    expect(block).toBeNull();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ step: 'diagnostics_block' }),
    );
    expect(counted('diagnostics.finalized_block')).toEqual([{ outcome: 'timeout', reason: 'timeout' }]);
  });
});
