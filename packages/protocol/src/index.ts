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
export {
  getProtocolOrigin,
  isRemoteChainConnectable,
  isRemoteChainSupported,
  protocolClient,
  type ProtocolClient,
  type ProtocolFrameConfig,
  type ProtocolStatus,
  type LocalWalletReadResult,
  type RemoteChainProvider,
  type SharedStoreStatus,
} from './client.js';
export { backendOfFrameMode } from './frame.js';
export {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
} from './errors.js';
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
  type TelemetryEvent,
} from './schema.js';
export {
  budgetOf,
  callName,
  CONNECT_BUDGET_MS,
  policyOf,
  RESOLVE_BUDGET_MS,
  type CallName,
  type MethodPolicy,
} from './method-policy.js';
export { failureOf, frameStatusEnd, fromTransportError, remoteEnd } from './outcomes.js';
export { createFrameStatus, type FrameStatus, type FrameStatusEnd, type FrameStatusSink } from './frame-status.js';
export { createIssueReporter, type WireIssue } from './wire-issues.js';
