// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { CacheNodes, testPayerSeed } from '../src/cache-nodes.js';
import {
  decodeRegistryList,
  REGISTRY_PROTOCOL,
  registryCallResult,
  registryListCall,
  registryProviders,
  type RegistryRecord,
} from '../src/cache-registry.js';
import vector from './registry-list.json' with { type: 'json' };

const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.slice(2).match(/../g) ?? [], b => parseInt(b, 16));

// A read of list() on a local network (contracts/vectors/list.json of the cache repository). The cache nodes and the
// CLI host decode the same bytes in their tests.
describe('the provider registry', () => {
  it('builds the call of the cache nodes and the hosts', () => {
    expect(registryListCall(vector.contract)).toBe(vector.args);
  });

  it('decodes a read of the chain', () => {
    const data = registryCallResult(vector.output);
    expect(data).toEqual(fromHex(vector.return));
    const records = decodeRegistryList(data);
    expect(records).toEqual(
      vector.providers.map(p => ({ ...p, registeredAt: BigInt(p.registeredAt), updatedAt: BigInt(p.updatedAt) })),
    );
    // B is inactive.
    expect(registryProviders(records).map(p => [p.name, p.api])).toEqual([
      ['A', 'https://cache-a.paseo.page'],
      ['C', 'https://cache-c.paseo.page'],
    ]);
  });

  it('uses the rules of the cache nodes', () => {
    const record: RegistryRecord = {
      operator: `0x${'11'.repeat(32)}`,
      endpointId: `0x${'07'.repeat(32)}`,
      api: 'https://cache.example.org/',
      name: '',
      region: '',
      dialHints: [],
      protocol: REGISTRY_PROTOCOL,
      registeredAt: 0n,
      updatedAt: 0n,
      active: true,
    };
    const usable = (change: Partial<RegistryRecord>): number => registryProviders([{ ...record, ...change }]).length;
    expect(registryProviders([record])).toEqual([
      { id: '07'.repeat(32), api: 'https://cache.example.org', operator: `0x${'11'.repeat(32)}` },
    ]);
    expect(usable({ api: 'http://127.0.0.1:18081' })).toBe(1);
    expect(usable({ api: 'http://localhost:18081' })).toBe(1);
    expect(usable({ api: 'http://cache.example.org' })).toBe(0);
    expect(usable({ api: 'ftp://cache.example.org' })).toBe(0);
    expect(usable({ api: 'not a url' })).toBe(0);
    expect(usable({ active: false })).toBe(0);
    expect(usable({ protocol: REGISTRY_PROTOCOL + 1 })).toBe(0);
  });

  it('refuses broken answers', () => {
    expect(() => registryCallResult(vector.output.slice(0, -2))).toThrow();
    const data = fromHex(vector.return);
    expect(() => decodeRegistryList(data.subarray(0, data.length - 40))).toThrow();
    expect(decodeRegistryList(new Uint8Array(64))).toEqual([]);
    expect(() => registryListCall('0x1234')).toThrow();
  });

  it('gives CacheNodes its provider set, and keeps the last set when a read fails', async () => {
    let fail = false;
    const nodes = new CacheNodes({
      payerSeed: testPayerSeed('registry'),
      storage: null,
      loadProviders: () =>
        fail ? Promise.reject(new Error('no chain')) : Promise.resolve([{ id: 'a'.repeat(64), api: 'https://a.org' }]),
    });
    expect((await nodes.providers()).map(p => p.api)).toEqual(['https://a.org']);
    fail = true;
    expect((await nodes.providers()).map(p => p.api)).toEqual(['https://a.org']);
  });
});
