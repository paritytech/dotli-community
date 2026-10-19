// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  SHARED_CORE_SESSION_KEY,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
} from './auth-storage.js';
export { getProtocolOrigin, protocolClient, type ProtocolClient } from './client.js';
export { backendOfFrameMode, type ProtocolFrameConfig, type ProtocolStatus } from './frame.js';
export { isRemoteChainConnectable, isRemoteChainSupported, type RemoteChainProvider } from './remote-chain.js';
export type { LocalWalletReadResult, SharedStoreStatus } from './shared-store.js';
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
export type { TelemetryEvent } from './codec-values.js';
export {
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
export { budgetOf, callName, policyOf, type CallName, type MethodPolicy } from './method-policy.js';
export { createFrameStatus, type FrameStatus, type FrameStatusEnd, type FrameStatusSink } from './frame-status.js';
export { createWireReport } from './wire-issues.js';
