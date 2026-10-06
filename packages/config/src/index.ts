// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/config. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export {
  BASE_DOMAIN,
  BLOCK_CACHE_MAX_BYTES,
  DEBUG,
  SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS,
  SCHEDULED_NOTIFICATIONS_MAX_AGE_MS,
  SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP,
  SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS,
  SITE_ID,
  isLocalhost,
  isSandboxOrigin,
  sandboxOriginForLabel,
  type SiteId,
} from './config.js';
export {
  SANDBOX_CONTRACT_PARAMS,
  SANDBOX_SCHEMA_VERSION,
  validateSandboxParams,
  type SandboxParams,
  type SandboxParamsResult,
} from './host-sandbox-contract.js';
export {
  BACKEND_KEY,
  BACKEND_LABELS,
  CACHE_KEY,
  POLKAVM_APPS_KEY,
  configureModeStorage,
  defaultPolkaVmAppsEnabled,
  getBackend,
  getCacheSettings,
  getPolkaVmAppsEnabled,
  isSharedWorkerAvailable,
  isVerifiedSession,
  localStorageAdapter,
  migrateLegacyOn,
  setBackend,
  setCacheSettings,
  setPolkaVmAppsEnabled,
  type Backend,
  type CacheSettings,
  type ModeStorage,
} from './mode.js';
export {
  CHAIN_ROLES,
  CHAIN_ROLE_LABELS,
  NETWORK_KEY,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  chainRoleForGenesis,
  getActiveChainRoles,
  getActiveCoreGatewayChains,
  getActiveCoreGatewaySupportedGenesisHashes,
  getActiveGatewayChains,
  getActiveGatewaySupportedGenesisHashes,
  getActiveServicesConfig,
  getActiveSupportedGenesisHashes,
  getActiveTldSuffix,
  getEnabledNetworks,
  getNetwork,
  isValidNetwork,
  setNetwork,
  setNetworkOverride,
  withActiveTld,
  type ActiveChainRole,
  type ChainRole,
  type ChainService,
  type DotnsContracts,
  type Network,
} from './network.js';
export { TIMEOUTS } from './timeouts.js';
export { parseSettingsFromSearch, writeSettingsToSearch } from './url-settings.js';
