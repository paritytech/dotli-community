// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The provider set from the provider registry contract on Asset Hub (contracts/ of github.com/paritytech/cache). The
// contract stands in for the service registry of Metanode: an operator registers each cache node there. A reader dry
// runs `list()` through the runtime API ReviveApi_call with the origin 0xEE…EE, at a finalized block. These functions
// build the call and decode the answer; the caller sends the call (dotli: chainHead_v1_call on Asset Hub). The cache
// nodes and the CLI host use the same layout and the same rules, so all find the same home nodes.

import { fromHex, toHex } from '@dotli/shared';

import type { CacheProvider } from './cache-nodes.js';

/** The version of the node API that this host speaks. A record with another version is not used. */
export const REGISTRY_PROTOCOL = 1;
// The selector of list(): the first 4 bytes of keccak256("list()").
const LIST_SELECTOR = [0x0f, 0x56, 0x0c, 0xd7];
// The flag of ExecReturnValue for a revert.
const REVERT = 1;

/** One record of the registry. Hex values have 0x. */
export interface RegistryRecord {
  operator: string;
  endpointId: string;
  api: string;
  name: string;
  region: string;
  dialHints: string[];
  protocol: number;
  registeredAt: bigint;
  updatedAt: bigint;
  active: boolean;
}

/** The SCALE arguments of ReviveApi_call for `list()` of the registry at `contract` (0x and 40 hex digits). */
export function registryListCall(contract: string): string {
  const address = fromHex(contract);
  if (address.length !== 20) {
    throw new Error(`the registry address ${contract} does not have 20 bytes`);
  }
  // origin, dest, value (u128), gas_limit: None, storage_deposit_limit: None, input (a Vec<u8>).
  const args = new Uint8Array(32 + 20 + 16 + 2 + 1 + LIST_SELECTOR.length);
  args.fill(0xee, 0, 32);
  args.set(address, 32);
  args[68] = 0;
  args[69] = 0;
  args[70] = LIST_SELECTOR.length << 2;
  args.set(LIST_SELECTOR, 71);
  return toHex(args);
}

// A cursor over SCALE bytes.
class Scale {
  private at = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  take(n: number): Uint8Array {
    if (this.at + n > this.data.length) {
      throw new Error('the result of ReviveApi_call is too short');
    }
    const bytes = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return bytes;
  }

  compact(): bigint {
    const first = this.take(1)[0] ?? 0;
    switch (first & 3) {
      case 0:
        return BigInt(first >> 2);
      case 1:
        return BigInt(((this.take(1)[0] ?? 0) << 6) | (first >> 2));
      case 2: {
        const rest = this.take(3);
        return BigInt((rest[2] ?? 0) * 2 ** 22 + ((rest[1] ?? 0) << 14) + ((rest[0] ?? 0) << 6) + (first >> 2));
      }
      default: {
        let value = 0n;
        const bytes = this.take((first >> 2) + 4);
        for (let i = bytes.length - 1; i >= 0; i--) {
          value = (value << 8n) | BigInt(bytes[i] ?? 0);
        }
        return value;
      }
    }
  }

  rest(): string {
    return toHex(this.data.subarray(this.at));
  }
}

/**
 * The return data of a ContractResult: weight_consumed and weight_required (two compact integers each),
 * storage_deposit and max_storage_deposit (a variant and a u128 each), gas_consumed (a u128), then
 * Result<ExecReturnValue, DispatchError>, where ExecReturnValue is the flags (a u32) and the data (a Vec<u8>).
 */
export function registryCallResult(output: string): Uint8Array {
  const scale = new Scale(fromHex(output));
  for (let i = 0; i < 4; i++) {
    scale.compact();
  }
  scale.take(2 * (1 + 16) + 16);
  if (scale.take(1)[0] !== 0) {
    throw new Error(`the dry run of list() failed: ${scale.rest()}`);
  }
  const flags = new DataView(scale.take(4).slice().buffer).getUint32(0, true);
  const data = scale.take(Number(scale.compact()));
  if ((flags & REVERT) !== 0) {
    throw new Error(`the registry reverted: ${toHex(data)}`);
  }
  // A call to an address without code succeeds and returns nothing.
  if (data.length === 0) {
    throw new Error('the registry address has no contract');
  }
  return data;
}

// ABI data, read with bounds checks. An offset of a dynamic value counts from the start of the value that holds it.
class Abi {
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  word(at: number): Uint8Array {
    if (!Number.isSafeInteger(at) || at < 0 || at + 32 > this.data.length) {
      throw new Error(`the ABI data is too short at byte ${String(at)}`);
    }
    return this.data.subarray(at, at + 32);
  }

  // An unsigned integer of at most 53 bits, for example an offset or a length.
  number(at: number): number {
    const word = this.word(at);
    if (word.subarray(0, 25).some(byte => byte !== 0)) {
      throw new Error(`a number too large at byte ${String(at)}`);
    }
    const value = word.subarray(25).reduce((total, byte) => total * 256 + byte, 0);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`a number too large at byte ${String(at)}`);
    }
    return value;
  }

  bigint(at: number): bigint {
    return this.word(at).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  }

  pointer(base: number, at: number): number {
    return base + this.number(at);
  }

  string(at: number): string {
    const length = this.number(at);
    const start = at + 32;
    if (start + length > this.data.length) {
      throw new Error(`a string longer than the data at byte ${String(at)}`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(this.data.subarray(start, start + length));
  }
}

/**
 * The records in the return data of `list()`: abi.encode(Provider[]), where Provider is (bytes32 operator, bytes32
 * endpointId, string api, string name, string region, string[] dialHints, uint16 protocol, uint64 registeredAt, uint64
 * updatedAt, bool active).
 */
export function decodeRegistryList(data: Uint8Array): RegistryRecord[] {
  const abi = new Abi(data);
  const array = abi.pointer(0, 0);
  const count = abi.number(array);
  // A record takes at least 10 words.
  if (count > data.length / 320) {
    throw new Error(`${String(count)} records in ${String(data.length)} bytes`);
  }
  const base = array + 32;
  return Array.from({ length: count }, (_, i) => {
    const record = abi.pointer(base, base + 32 * i);
    const field = (n: number): number => record + 32 * n;
    const hints = abi.pointer(record, field(5));
    const active = abi.number(field(9));
    if (active > 1) {
      throw new Error(`a bool of ${String(active)}`);
    }
    return {
      operator: toHex(abi.word(field(0))),
      endpointId: toHex(abi.word(field(1))),
      api: abi.string(abi.pointer(record, field(2))),
      name: abi.string(abi.pointer(record, field(3))),
      region: abi.string(abi.pointer(record, field(4))),
      dialHints: Array.from({ length: abi.number(hints) }, (_, j) =>
        abi.string(abi.pointer(hints + 32, hints + 32 + 32 * j)),
      ),
      protocol: abi.number(field(6)),
      registeredAt: abi.bigint(field(7)),
      updatedAt: abi.bigint(field(8)),
      active: active === 1,
    };
  });
}

function apiAllowed(api: string): boolean {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return url.hostname !== '';
  }
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/**
 * The providers that a host uses: active records with this protocol, and an https:// API URL (http:// only on the
 * loopback, for a local network). The cache nodes and the CLI host use the same rules.
 */
export function registryProviders(records: RegistryRecord[]): CacheProvider[] {
  return records
    .filter(record => record.active && record.protocol === REGISTRY_PROTOCOL && apiAllowed(record.api))
    .map(record => {
      const provider: CacheProvider = { id: record.endpointId.slice(2), api: record.api.replace(/\/$/, '') };
      if (record.name !== '') {
        provider.name = record.name;
      }
      if (record.region !== '') {
        provider.region = record.region;
      }
      provider.operator = record.operator;
      return provider;
    });
}
