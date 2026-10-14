// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import vector from './registry-list.json' with { type: 'json' };

// A read of list() on a local network (contracts/vectors/list.json of the cache repository).
const mocks = vi.hoisted(() => ({ finalizedRuntimeCall: vi.fn() }));
vi.mock('@dotli/resolver', () => ({ finalizedRuntimeCall: mocks.finalizedRuntimeCall }));

const { registryLoader, registryState } = await import('../src/host-callbacks/cache-registry.js');

const CONTRACT = vector.contract;
const provider = (() => ({}) as JsonRpcProvider) as () => JsonRpcProvider;
const answer = { output: vector.output, block: { hash: '0x00', number: 7 } };

describe('the provider registry of the cache-node setting', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.finalizedRuntimeCall.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a user without a saved set, my first read waits for the registry, and the set is saved', async () => {
    mocks.finalizedRuntimeCall.mockResolvedValue(answer);
    const load = registryLoader(CONTRACT, provider);

    const providers = await load();

    expect(mocks.finalizedRuntimeCall).toHaveBeenCalledWith(expect.anything(), 'ReviveApi_call', vector.args);
    expect(providers.map(p => p.name)).toEqual(['A', 'C']);
    expect(registryState()).toMatchObject({ contract: CONTRACT, block: 7 });
    expect(JSON.parse(localStorage.getItem('dotli:cache-registry') ?? '{}')).toMatchObject({
      contract: CONTRACT,
      block: 7,
    });
  });

  it('As a user with a saved set, a read does not wait for the chain, and a failed read keeps the set', async () => {
    localStorage.setItem(
      'dotli:cache-registry',
      JSON.stringify({ contract: CONTRACT, block: 3, providers: [{ id: 'a'.repeat(64), api: 'https://saved' }] }),
    );
    mocks.finalizedRuntimeCall.mockReturnValue(new Promise(() => undefined));
    const load = registryLoader(CONTRACT, provider);

    expect((await load()).map(p => p.api)).toEqual(['https://saved']);

    mocks.finalizedRuntimeCall.mockRejectedValue(new Error('no peer'));
    const failing = registryLoader(CONTRACT, provider);
    expect((await failing()).map(p => p.api)).toEqual(['https://saved']);
    await vi.waitFor(() => {
      expect(registryState()?.error).toBe('no peer');
    });
  });

  it('As a user of another registry, a set saved for the old contract is not used', async () => {
    localStorage.setItem(
      'dotli:cache-registry',
      JSON.stringify({
        contract: '0x' + '11'.repeat(20),
        block: 3,
        providers: [{ id: 'a'.repeat(64), api: 'https://old' }],
      }),
    );
    mocks.finalizedRuntimeCall.mockRejectedValue(new Error('no peer'));

    await expect(registryLoader(CONTRACT, provider)()).rejects.toThrow('no peer');
  });
});
