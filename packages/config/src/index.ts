// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  BASE_DOMAIN,
  BLOCK_CACHE_MAX_BYTES,
  DEBUG,
  DEV_PROTOCOL_PORT,
  DEV_SANDBOX_PORT,
  SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS,
  SCHEDULED_NOTIFICATIONS_MAX_AGE_MS,
  SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP,
  SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS,
  SITE_ID,
  isLocalhost,
  isSandboxOrigin,
  type SiteId,
} from './config.js';
export {
  BACKEND_KEY,
  BACKEND_LABELS,
  CACHE_KEY,
  getBackend,
  getCacheSettings,
  isSharedWorkerAvailable,
  isVerifiedSession,
  localStorageAdapter,
  type Backend,
  type CacheSettings,
  type ModeStorage,
} from './mode.js';
export {
  CHAIN_ROLES,
  CHAIN_ROLE_LABELS,
  NETWORK_KEY,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
  chainRoleForGenesis,
  getActiveChainRoles,
  getActiveCoreGatewayChains,
  getActiveCoreGatewaySupportedGenesisHashes,
  getActiveFixedServicesConfig,
  getActiveGatewayChains,
  getActiveGatewaySupportedGenesisHashes,
  getActiveServicesConfig,
  getActiveSupportedGenesisHashes,
  getActiveTldSuffix,
  getEnabledNetworks,
  getNetwork,
  getTldSuffix,
  isValidNetwork,
  withActiveTld,
  type ActiveChainRole,
  type ChainRole,
  type ChainService,
  type DotnsContracts,
  type FixedChainService,
  type FixedServicesConfig,
  type Network,
} from './network.js';
export { setSettings } from './active-settings.js';
export {
  getSettings,
  hasStoredSettings,
  resolveSettings,
  setActiveNetwork,
  sharedSettingsOf,
  writeLocalSettings,
  type Settings,
  type SettingsSources,
  type SharedSettings,
} from './settings.js';
export { TIMEOUTS } from './timeouts.js';
export { parseSettingsFromSearch, writeSettingsToSearch, type ParsedUrlSettings } from './url-settings.js';
