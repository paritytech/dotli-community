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
export { budgetOf, CONNECT_BUDGET_MS, RESOLVE_BUDGET_MS } from './method-timeouts.js';
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
export { callName, type CallName } from './call-names.js';
export { failureOf, frameStatusEnd, fromTransportError, remoteFailureOf } from './outcomes.js';
export { createFrameStatus, type FrameStatus, type FrameStatusEnd, type FrameStatusSink } from './frame-status.js';
export { createIssueReporter, type WireIssue } from './wire-issues.js';
