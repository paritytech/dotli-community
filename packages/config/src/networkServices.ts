// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { applyNetworkOverrides } from './applyNetworkOverrides.js';
import type { Network } from './networkNames.js';
import type { ServicesConfig } from './types.js';

/** The built-in networks, before any runtime override. */
export const BUILTIN_NETWORK_SERVICES: Record<Network, ServicesConfig> = {
  'paseo-next-v2': {
    label: 'Paseo',
    description: 'Paseo Next Network',
    relay: {
      genesis: '0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd',
      rpcs: [
        'wss://paseo-rpc.n.dwellir.com',
        'wss://paseo.dotters.network',
        'wss://paseo.ibp.network',
        'wss://paseo.rpc.amforc.com',
      ],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis: '0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a',
      rpcs: ['wss://paseo-asset-hub-next-rpc.polkadot.io'],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis: '0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22',
      rpcs: ['wss://paseo-bulletin-next-rpc.polkadot.io'],
      blockTimeMs: 6000,
      ipfsGateways: ['https://paseo-bulletin-next-ipfs.polkadot.io'],
    },
    people: {
      genesis: '0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48',
      rpcs: ['wss://paseo-people-next-system-rpc.polkadot.io'],
      blockTimeMs: 2000,
    },
    dotns: {
      DOTNS_REGISTRY: '0xf34054fd76BbF85f216cf9908226D5f0A72E50CA',
      DOTNS_CONTENT_RESOLVER: '0x7F74D7CD50f5a834270E2ad395a01b01891AB37d',
      STORE_FACTORY: '0x99605a926FcB40aB520F659c6505E5ff862771f6',
      STORAGE_SLOTS: {
        REGISTRY_RECORDS: 0,
        CONTENTHASH: 0,
        TEXT_RECORDS: 1,
        REGISTRY_PROTOCOL_REGISTRY: 1,
        PROTOCOL_REGISTRY_ADDRESSES: 0,
        REGISTRAR_OWNERS: '0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079302',
        STORE_FACTORY_LABEL_STORES: 5,
        LABEL_STORE_LABELS: 2,
        LABEL_STORE_LABEL_LIST: 3,
      },
      TLD: 'paseo',
    },
  },
  previewnet: {
    label: 'Previewnet',
    description: 'Product Preview Network',
    relay: {
      genesis: '0x860145753657e73c29b9388ffa0a8aebc643ea87434b4b271b6c3c3cc9e6bf92',
      rpcs: ['wss://previewnet.substrate.dev/relay/alice', 'wss://previewnet.substrate.dev/relay/bob'],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis: '0xbac97e23fc8f4bccae72a98f8aeb2bcab20bf755862304e4b46ad6473456e896',
      rpcs: ['wss://previewnet.substrate.dev/asset-hub'],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis: '0xa081192b90c1f6a3f8e9ce7b2a8246f41af805c66456c84e05fd97c2b3502425',
      rpcs: ['wss://previewnet.substrate.dev/bulletin'],
      blockTimeMs: 6000,
      ipfsGateways: ['https://previewnet.substrate.dev'],
    },
    people: {
      genesis: '0x55e3e689ecfa9d2fffcf7d309b8011956671493982230bfd0420c683542249e9',
      rpcs: ['wss://previewnet.substrate.dev/people'],
      blockTimeMs: 2000,
    },
    dotns: {
      DOTNS_REGISTRY: '0xf34054fd76BbF85f216cf9908226D5f0A72E50CA',
      DOTNS_CONTENT_RESOLVER: '0x7F74D7CD50f5a834270E2ad395a01b01891AB37d',
      STORE_FACTORY: '0x99605a926FcB40aB520F659c6505E5ff862771f6',
      STORAGE_SLOTS: {
        REGISTRY_RECORDS: 0,
        CONTENTHASH: 0,
        TEXT_RECORDS: 1,
        REGISTRY_PROTOCOL_REGISTRY: 1,
        PROTOCOL_REGISTRY_ADDRESSES: 0,
        REGISTRAR_OWNERS: '0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079302',
        STORE_FACTORY_LABEL_STORES: 5,
        LABEL_STORE_LABELS: 2,
        LABEL_STORE_LABEL_LIST: 3,
      },
      TLD: 'testnet',
    },
  },
  'pcf-devnet': {
    label: 'PCF Devnet',
    description: 'Polkadot Community Foundation devnet on Paseo',
    relay: {
      genesis: '0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd',
      rpcs: [
        'wss://paseo-rpc.n.dwellir.com',
        'wss://paseo-v2.rpc.turboflakes.io',
        'wss://rpc-paseo.stakeworld.io',
        'wss://rpc.interweb-it.com/paseo',
      ],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis: '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2',
      rpcs: ['wss://asset-hub-paseo-rpc.n.dwellir.com', 'wss://sys.turboflakes.io/asset-hub-paseo'],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis: '0xe101f0fa4627d29a257645e02be86d80378fea1a2bf8fa6a918d150ebc760a59',
      rpcs: ['wss://bullet.sik.rocks', 'wss://bullet.tunastaking.eu', 'wss://bulletin-paseo.tservices.es:8443'],
      blockTimeMs: 6000,
      ipfsGateways: ['https://devnet-ipfs.api.polkadotcommunity.foundation'],
    },
    people: {
      genesis: '0xe6c30d6e148f250b887105237bcaa5cb9f16dd203bf7b5b9d4f1da7387cb86ec',
      rpcs: [
        'wss://people-devnet-rpc.api.polkadotcommunity.foundation',
        'wss://people-paseo.gatotech.network',
        'wss://people-paseo.rotko.net',
        'wss://rpc.interweb-it.com/people-paseo',
      ],
      blockTimeMs: 2000,
    },
    dotns: {
      DOTNS_REGISTRY: '0xb052E5EfC5ADEff1f21d48DEfb5169Cb394A1a73',
      DOTNS_CONTENT_RESOLVER: '0x7e75491ecfb04900EB05ee63CABA2B33900aABB5',
      STORE_FACTORY: '0x5Df012daA06cA2602DA153309C2E3A83284Cb879',
      STORAGE_SLOTS: {
        REGISTRY_RECORDS: 0,
        CONTENTHASH: 0,
        TEXT_RECORDS: 1,
        REGISTRY_PROTOCOL_REGISTRY: 1,
        PROTOCOL_REGISTRY_ADDRESSES: 0,
        REGISTRAR_OWNERS: '0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079302',
        STORE_FACTORY_LABEL_STORES: 5,
        LABEL_STORE_LABELS: 2,
        LABEL_STORE_LABEL_LIST: 3,
      },
      TLD: 'dot',
    },
  },
};

/** Built-in networks with any runtime endpoint overrides applied. */
export const NETWORK_NAME_TO_SERVICES_CONFIG: Record<Network, ServicesConfig> = applyNetworkOverrides({
  base: BUILTIN_NETWORK_SERVICES,
});
