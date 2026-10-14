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
export {
  getProtocolOrigin,
  isRemoteChainConnectable,
  isRemoteChainSupported,
  protocolClient,
  type ProtocolClient,
  type ProtocolFrameConfig,
  type ProtocolStatus,
  type RemoteChainProvider,
  type SharedStoreStatus,
} from './client.js';
export { backendOfFrameMode } from './frame.js';
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
