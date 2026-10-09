// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  SHARED_CORE_SESSION_KEY,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isSharedWalletRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  type SharedWalletRequestMethod,
} from './auth-storage.js';
export { requireBrokerLocalProvider, type ChainBrokerManager, type StringJsonRpcConnection } from './broker.js';
export {
  CHAIN_HALTED_ERROR_DATA,
  chainHaltedError,
  ChainHaltError,
  haltReasonOf,
  type RemoteChainHalt,
} from './chain-halted.js';
export {
  createChainPool,
  type ChainActivity,
  type ChainPool,
  type ChainPoolWatcher,
  type LeaseProvider,
} from './chain-pool.js';
export {
  clearSharedAuthStorage,
  clearSharedModeStorage,
  forgetSharedLocalWallet,
  readSharedLocalWallet,
  saveSharedLocalWallet,
  updateSharedLocalWalletIdentity,
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
  resolveDotNameRemote,
  resolveExecutableManifestRemote,
  resolveRootManifestRemote,
  setProtocolSubMode,
  subscribeSharedAuthStorage,
  type RemoteChainProvider,
  warmupProtocol,
  writeSharedAuthStorage,
  writeSharedModeStorage,
} from './client.js';
export { ProtocolFatalError, ProtocolInitFailedError } from './errors.js';
export {
  getRequestSyncTimeoutMs,
  isProtocolEnvelope,
  type LocalWalletIdentity,
  type LocalWalletReadResult,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type SmoldotDbChain,
  type SmoldotDbOutcome,
} from './messages.js';
