// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Field by field rather than a deep merge, so nothing walks the prototype chain and what an override can reach stays
// legible. `genesis` and `blockTimeMs` are never read from the patch.

import { describeValueType } from './describeValueType.js';
import { isValidNetwork, type Network } from './networkNames.js';
import { readRecord } from './readRecord.js';
import { RUNTIME_GLOBAL_KEY, readRuntimeNetworkConfig } from './readRuntimeNetworkConfig.js';
import { readStrings } from './readStrings.js';
import type { BulletinService, ChainService, FixedChainService, ServicesConfig } from './types.js';

type Params = {
  /** The networks to patch. Never mutated, the result is a new record unless there is nothing to patch. */
  base: Record<Network, ServicesConfig>;
  /** The per-network patches. Omitted or undefined, the runtime config's patches. */
  patches?: Record<string, unknown> | undefined;
};

type MergeParams<Service> = {
  base: Service;
  raw: unknown;
  path: string;
};

type CheckFieldsParams = {
  patch: Record<string, unknown>;
  allowed: readonly string[];
  path: string;
};

// Typed so a fixed field cannot be added to an allow list.
const CHAIN_OVERRIDES = ['rpcs'] as const satisfies readonly Exclude<keyof ChainService, keyof FixedChainService>[];
const BULLETIN_OVERRIDES = ['rpcs', 'ipfsGateways'] as const satisfies readonly Exclude<
  keyof BulletinService,
  keyof FixedChainService
>[];
const NETWORK_OVERRIDES = ['label', 'relay', 'assethub', 'bulletin', 'people'] as const satisfies readonly Exclude<
  keyof ServicesConfig,
  'dotns'
>[];

/** `base` with the runtime config's per-network `patches` merged over it. Throws on a patch it cannot apply. */
export function applyNetworkOverrides({
  base,
  patches = readRuntimeNetworkConfig()?.networks,
}: Params): Record<Network, ServicesConfig> {
  if (patches === undefined) {
    return base;
  }
  const label = `globalThis.${RUNTIME_GLOBAL_KEY}.networks`;
  const merged = { ...base };
  for (const name of Object.keys(patches)) {
    // A lookup in the fixed set, not `in`: JSON.parse yields `__proto__` as an own key, and `in` would accept it as a
    // known network.
    if (!isValidNetwork(name)) {
      throw new Error(
        `${label} targets unknown network "${name}". Valid values: ${Object.keys(base).join(
          ', ',
        )}. Overrides patch existing networks; they cannot add new ones.`,
      );
    }
    merged[name] = mergeNetwork({ base: base[name], raw: patches[name], path: `${label}.${name}` });
  }
  return merged;
}

function mergeNetwork({ base, raw, path }: MergeParams<ServicesConfig>): ServicesConfig {
  const patch = readRecord(raw, path);
  checkFields({ patch, allowed: NETWORK_OVERRIDES, path });
  return {
    ...base,
    label: patch['label'] === undefined ? base.label : readString(patch['label'], `${path}.label`),
    relay:
      patch['relay'] === undefined
        ? base.relay
        : mergeChain({ base: base.relay, raw: patch['relay'], path: `${path}.relay` }),
    assethub:
      patch['assethub'] === undefined
        ? base.assethub
        : mergeChain({ base: base.assethub, raw: patch['assethub'], path: `${path}.assethub` }),
    bulletin:
      patch['bulletin'] === undefined
        ? base.bulletin
        : mergeBulletin({ base: base.bulletin, raw: patch['bulletin'], path: `${path}.bulletin` }),
    people:
      patch['people'] === undefined
        ? base.people
        : mergeChain({ base: base.people, raw: patch['people'], path: `${path}.people` }),
  };
}

function mergeChain({ base, raw, path }: MergeParams<ChainService>): ChainService {
  const patch = readRecord(raw, path);
  checkFields({ patch, allowed: CHAIN_OVERRIDES, path });
  return {
    genesis: base.genesis,
    blockTimeMs: base.blockTimeMs,
    rpcs: patch['rpcs'] === undefined ? base.rpcs : readStrings(patch['rpcs'], `${path}.rpcs`),
  };
}

function mergeBulletin({ base, raw, path }: MergeParams<BulletinService>): BulletinService {
  const patch = readRecord(raw, path);
  checkFields({ patch, allowed: BULLETIN_OVERRIDES, path });
  return {
    genesis: base.genesis,
    blockTimeMs: base.blockTimeMs,
    rpcs: patch['rpcs'] === undefined ? base.rpcs : readStrings(patch['rpcs'], `${path}.rpcs`),
    ipfsGateways:
      patch['ipfsGateways'] === undefined
        ? base.ipfsGateways
        : readStrings(patch['ipfsGateways'], `${path}.ipfsGateways`),
  };
}

function checkFields({ patch, allowed, path }: CheckFieldsParams): void {
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${path}.${key} is not overridable. Valid fields: ${allowed.join(
          ', ',
        )}. genesis and dotns are deliberately fixed at build time.`,
      );
    }
  }
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string, got ${describeValueType(value)}.`);
  }
  return value;
}
