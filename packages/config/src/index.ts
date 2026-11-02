// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  getActiveCoreGatewayChains,
  getActiveCoreGatewaySupportedGenesisHashes,
  getActiveGatewaySupportedGenesisHashes,
  getActiveServicesConfig,
  getActiveSupportedGenesisHashes,
  getActiveTldSuffix,
  getNetwork,
  withActiveTld,
} from './activeNetwork.js';
export { setSettings, subscribeSettings } from './activeSettings.js';
export type { Backend } from './backend.js';
export { BACKEND_KEY, BACKEND_LABELS, getBackend, isVerifiedSession, parseBackend } from './backend.js';
export type { SiteId } from './baseDomain.js';
export { BASE_DOMAIN, LOCAL_ROOT, SITE_ID, isLocalhost } from './baseDomain.js';
export type { CacheSettings } from './cacheSettings.js';
export { CACHE_KEY, getCacheSettings } from './cacheSettings.js';
export type { ActiveChainRole, ChainRole } from './chainRoles.js';
export { CHAIN_ROLES, CHAIN_ROLE_LABELS, getActiveChainRoles, getChainRoleForGenesis } from './chainRoles.js';
export { DEBUG } from './debug.js';
export { DEV_HOST_PORT, DEV_PROTOCOL_PORT, DEV_SANDBOX_PORT } from './devPorts.js';
export { getDefaultNetwork, getEnabledNetworks } from './getEnabledNetworks.js';
export { getHostPlace } from './getHostPlace.js';
export { getLocalRoot } from './getLocalRoot.js';
export { getSharedSettings } from './getSharedSettings.js';
export { hasStoredSettings } from './hasStoredSettings.js';
export { isSandboxOrigin } from './isSandboxOrigin.js';
export { isSharedWorkerAvailable } from './isSharedWorkerAvailable.js';
export { isSiteOrigin } from './isSiteOrigin.js';
export type { Network } from './networkNames.js';
export { NETWORK_KEY, NETWORK_NAMES, isValidNetwork } from './networkNames.js';
export { NETWORK_NAME_TO_SERVICES_CONFIG } from './networkServices.js';
export type { ResolvedSettings, Settings, SettingsSources, SharedSettings } from './resolveSettings.js';
export { resolveSettings } from './resolveSettings.js';
export { getSettings, setActiveNetwork } from './settings.js';
export { TIMEOUTS } from './timeouts.js';
export type { ChainService, DotnsContracts, FixedChainService, FixedServicesConfig } from './types.js';
export type { ParsedUrlSettings } from './urlSettings.js';
export { parseSettingsFromSearch, writeSettingsToSearch } from './urlSettings.js';
export { writeLocalSettings } from './writeLocalSettings.js';
