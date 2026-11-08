// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getBackend, hasLightClient, type Backend } from '@dotli/config';
import { getProtocolClient, isFrameDown, isRemoteChainConnectable, type ProtocolStatus } from '@dotli/protocol';
import {
  createChainPool,
  createCoreRpcChainTransport,
  isCoreRpcChainSupported,
  type ChainPool,
  type ChainTransport,
  type ChainTransportHooks,
} from '@dotli/chains';
import {
  createFrameChainTransport,
  createPageRemoteChain,
  type RemoteChainFactory,
} from './createFrameChainTransport.js';

/** Where the host's chains come from on each backend. */
export type HostChainSources = {
  /** The backend in force, never null. Never throws. */
  backend: () => Backend;
  /**
   * Opens the light client backends' connections to the protocol frame. Answers null for a chain the frame cannot
   * serve. Never throws.
   */
  createRemoteChain: RemoteChainFactory;
  /** Whether the protocol frame serves the chain. Never throws. */
  isRemoteChainConnectable: (genesisHash: string) => boolean;
  /** Opens Trusted Providers' own sockets. Answers null for a chain they do not serve. Never throws. */
  createRpcChain: (genesisHash: string, hooks: ChainTransportHooks) => ChainTransport | null;
  /** Whether Trusted Providers serve the chain. Never throws. */
  isRpcChainSupported: (genesisHash: string) => boolean;
};

type Params = {
  /** Unset, an idle chain closes after the pool's default minute. */
  destroyDelay?: number | undefined;
  /** The protocol frame whose status holds back a lease that halted with it. The page's frame by default. */
  frame?: FrameStatusSource;
} & Partial<Pick<HostChainSources, 'backend' | 'createRemoteChain' | 'createRpcChain'>>;

/** The protocol frame's status, read when a lease that died with the frame would be taken again. */
export type FrameStatusSource = {
  /** The frame's status now. Never throws. */
  getProtocolStatus(): ProtocolStatus;
};

/** The page's chain sources, read lazily on each call. */
export const pageSources: HostChainSources = {
  backend: getBackend,
  createRemoteChain: createPageRemoteChain,
  isRemoteChainConnectable,
  createRpcChain: (genesisHash, hooks) => createCoreRpcChainTransport(genesisHash, { hooks }),
  isRpcChainSupported: isCoreRpcChainSupported,
};

/** Every backend switch reloads the page, so a pool entry never outlives its backend. */
export function createHostChainPool({
  destroyDelay,
  frame = protocolFrame,
  backend = pageSources.backend,
  createRemoteChain = pageSources.createRemoteChain,
  createRpcChain = pageSources.createRpcChain,
}: Params = {}): ChainPool {
  function createTransport(genesisHash: string, hooks: ChainTransportHooks): ChainTransport | null {
    return hasLightClient(backend())
      ? createFrameChainTransport(genesisHash, hooks, { createRemoteChain })
      : createRpcChain(genesisHash, hooks);
  }

  return createChainPool({
    // Reopening is cheap on every backend, since the frame keeps the light client's chain.
    ...(destroyDelay === undefined ? {} : { destroyDelay }),
    createTransport,
    isFrameDown: () => isFrameDown(frame.getProtocolStatus()),
  });
}

/** The page's protocol frame status, read from the protocol client on each call. */
const protocolFrame: FrameStatusSource = { getProtocolStatus: () => getProtocolClient().frame.status.get() };

/** The page's one host chain pool. */
export const hostChainPool = createHostChainPool();
