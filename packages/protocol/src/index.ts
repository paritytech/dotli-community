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
  type LocalWalletIdentity,
  type ProtocolContext,
  type ProtocolSchema,
  type ProtocolTransport,
  type TelemetryEvent,
} from './schema.js';
export { callName } from './call-names.js';
export { failureOf } from './outcomes.js';
export { createIssueReporter } from './wire-issues.js';
