// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type DotnsStorageSlots = {
  readonly REGISTRY_RECORDS: number;
  readonly CONTENTHASH: number;
  readonly TEXT_RECORDS?: number;
  /** Registry storage slot of the protocol registry's address. */
  readonly REGISTRY_PROTOCOL_REGISTRY: number;
  /** Protocol registry mapping slot of its address book, keyed by a bytes32 name. */
  readonly PROTOCOL_REGISTRY_ADDRESSES: number;
  /** Registrar mapping base slot of the ERC-721 token holders, keyed by the node as a uint256. */
  readonly REGISTRAR_OWNERS: `0x${string}`;
};

export type DotnsContracts = {
  readonly DOTNS_REGISTRY: `0x${string}`;
  readonly DOTNS_CONTENT_RESOLVER: `0x${string}`;
  readonly STORAGE_SLOTS: DotnsStorageSlots;
  /** Bare TLD label this network registers names under, e.g. `dot` or `paseo`. */
  readonly TLD: string;
};

/** The part of a chain entry a runtime override cannot change. */
export type FixedChainService = {
  readonly genesis: string;
  /**
   * Expected block interval. Measured, because no runtime constant yields it for a parachain: `Aura.SlotDuration` is
   * the async-backing slot, and `BLOCK_PROCESSING_VELOCITY` is absent from metadata.
   */
  readonly blockTimeMs: number;
};

export type ChainService = {
  readonly rpcs: readonly string[];
} & FixedChainService;

export type BulletinService = {
  readonly ipfsGateways: readonly string[];
} & ChainService;

/**
 * The part of a network entry a runtime override cannot change. The protocol SharedWorker has no document, so it never
 * sees the runtime config and reads only this, which keeps it in agreement with the documents.
 */
export type FixedServicesConfig = {
  readonly relay: FixedChainService;
  readonly assethub: FixedChainService;
  readonly bulletin: FixedChainService;
  readonly people: FixedChainService;
  readonly dotns: DotnsContracts;
};

export type ServicesConfig = {
  readonly label: string;
  readonly description: string;
  readonly relay: ChainService;
  readonly assethub: ChainService;
  readonly bulletin: BulletinService;
  readonly people: ChainService;
  readonly dotns: DotnsContracts;
} & FixedServicesConfig;
