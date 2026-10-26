// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  SHARED_AUTH_KEY_PREFIX,
  SHARED_CORE_SESSION_KEY,
  SHARED_MODE_KEY_PREFIX,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
} from './authStorage.js';
export { getProtocolOrigin, protocolClient, type ProtocolClient } from './client.js';
export { backendOfFrameMode, type ProtocolFrameConfig, type ProtocolStatus } from './frame.js';
export { isRemoteChainConnectable, isRemoteChainSupported, type RemoteChainProvider } from './remoteChain.js';
export type { LocalWalletReadResult, SharedStoreStatus } from './sharedStore.js';
export {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
  failureOf,
  frameStatusEnd,
  fromTransportError,
  remoteEnd,
} from './errors.js';
export type { TelemetryEvent } from './codecValues.js';
export {
  isLocalWalletEntropy,
  isLocalWalletIdentity,
  protocolSchema,
  type DomainFailure,
  type FrameFailure,
  type LocalWalletIdentity,
  type LocalWalletRead,
  type ProtocolContext,
  type ProtocolHandler,
  type ProtocolHello,
  type ProtocolSchema,
  type ProtocolServing,
  type ProtocolTransport,
  type RemoteFailure,
  type SharedAuthChange,
  type SubscriptionEnd,
} from './schema.js';
export { budgetOf, callName, policyOf, type CallName, type MethodPolicy } from './methodPolicy.js';
export { createFrameStatus, type FrameStatus, type FrameStatusEnd, type FrameStatusSink } from './frameStatus.js';
export { endListeners } from './subscription.js';
export { createWireReport } from './wireIssues.js';
