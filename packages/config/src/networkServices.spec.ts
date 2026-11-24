// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainRole } from './chainRoles.js';
import { loadStack } from './loadStack.js';
import { NETWORK_NAMES, type Network } from './networkNames.js';
import { BUILTIN_NETWORK_SERVICES } from './networkServices.js';

// The role names the stack descriptor gives each chain.
const STACK_ROLES: Record<ChainRole, string> = {
  relay: 'Relay',
  assethub: 'AssetHub',
  bulletin: 'Bulletin',
  people: 'People',
};

type StackChain = { role: string; genesisHash: string };

// The `trinity-stack` CLI verified the copy's signature when it wrote it, so the test only reads its payload.
async function readStackGenesis(network: Network): Promise<Record<ChainRole, string>> {
  const { descriptor } = await loadStack(network);
  const { payload } = JSON.parse(new TextDecoder().decode(descriptor)) as { payload: string };
  const { chains } = JSON.parse(atob(payload)) as { chains: StackChain[] };
  const genesisOf = (role: ChainRole) => chains.find(chain => chain.role === STACK_ROLES[role])?.genesisHash ?? '';
  return {
    relay: genesisOf('relay'),
    assethub: genesisOf('assethub'),
    bulletin: genesisOf('bulletin'),
    people: genesisOf('people'),
  };
}

describe('BUILTIN_NETWORK_SERVICES', () => {
  it('As a user on any network, dotli connects the chains its signed stack names, so the core finds every chain it dials after a stack update', async () => {
    // Given every network the build knows

    // When each one's signed stack is read
    const stacks = await Promise.all(NETWORK_NAMES.map(readStackGenesis));

    // Then each chain in the network table has the genesis hash its stack names
    expect(
      NETWORK_NAMES.map(network => {
        const services = BUILTIN_NETWORK_SERVICES[network];
        return {
          network,
          relay: services.relay.genesis,
          assethub: services.assethub.genesis,
          bulletin: services.bulletin.genesis,
          people: services.people.genesis,
        };
      }),
    ).toEqual(NETWORK_NAMES.map((network, index) => ({ network, ...stacks[index] })));
  });
});
