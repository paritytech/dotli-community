// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/protocol. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export {
  SHARED_CORE_SESSION_KEY,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
} from './auth-storage.js';
export { requireBrokerLocalProvider, type ChainBrokerManager, type StringJsonRpcConnection } from './broker.js';
export {
  CHAIN_HALTED_ERROR_DATA,
  chainHaltedError,
  ChainHaltError,
  haltReasonOf,
  type RemoteChainHalt,
} from './chain-halted.js';
export { createChainPool, type ChainPool, type ChainPoolOptions, type LeaseProvider } from './chain-pool.js';
export {
  clearSharedAuthStorage,
  clearSharedModeStorage,
  createRemoteChainProvider,
  ensureProtocolFrame,
  getProtocolOrigin,
  getSmoldotDbOutcome,
  isProtocolBooting,
  isProtocolReady,
  isRemoteChainConnectable,
  isRemoteChainSupported,
  onProtocolChainDetail,
  onProtocolChainSync,
  onProtocolNetBytes,
  onProtocolReady,
  readSharedAuthStorage,
  readSharedModeStorage,
  resetProtocolFrame,
  requestSharedWallet,
  requestWalletOwner,
  resolveDotNameRemote,
  resolveExecutableManifestRemote,
  resolveRootManifestRemote,
  setProtocolSubMode,
  subscribeSharedAuthStorage,
  subscribeSharedWallet,
  subscribeWalletOwnerRevoked,
  type RemoteChainProvider,
  warmupProtocol,
  writeSharedAuthStorage,
  writeSharedModeStorage,
} from './client.js';
export { ProtocolFatalError, ProtocolInitFailedError } from './errors.js';
export {
  getRequestSyncTimeoutMs,
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type SmoldotDbChain,
  type SmoldotDbOutcome,
} from './messages.js';
export { METHOD_TIMEOUTS } from './method-timeouts.js';
export {
  isSharedWalletOperation,
  isSharedWalletState,
  type SharedWalletOperation,
  type SharedWalletResult,
  type SharedWalletState,
} from './wallet-storage.js';
export {
  createWalletOwner,
  isWalletOwnerOperation,
  WALLET_OWNER_BUSY_ERROR,
  WALLET_OWNER_REVOKED_EVENT,
  type WalletOwner,
  type WalletOwnerDeps,
  type WalletOwnerOperation,
} from './wallet-owner.js';
