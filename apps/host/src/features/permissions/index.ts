// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export { PermissionsButtonIsland } from './panel/PermissionsButtonIsland.js';
export { PermissionsItem } from './panel/PermissionsItem.js';
export { SignIcon } from './panel/SignIcon.js';
export { createBrowserBlockCheck } from './prompts/createBrowserBlockCheck.js';
export type { BrowserPermissionStatus, BrowserPermissions } from './policy/createBrowserPermissions.js';
export { browserPermissions } from './policy/createBrowserPermissions.js';
export { hostPrompts } from './prompts/createHostPrompts.js';
export type { PermissionAuthorizations } from './policy/createPermissionAuthorizations.js';
export { createPermissionAuthorizations } from './policy/createPermissionAuthorizations.js';
export type { GrantAnswer, HostPrompts } from './prompts/hostPrompts.js';
export { getLastingStatus, isDismissed, isGranted, toPermissionDecision } from './prompts/hostPrompts.js';
export { pagePermissions, productPermissions } from './policy/pagePermissions.js';
export { getGrantButtons } from './prompts/permissionDialog.js';
export type { EnforceablePermissionName, PermissionStatus } from './policy/permissionPolicy.js';
export { ALL_PERMISSIONS, hasFrameDirective, isEnforceableDevicePermission } from './policy/permissionPolicy.js';
export type { PermissionsChange, ProductPermissions } from './policy/productPermissions.js';
export { createProductPermissions } from './policy/productPermissions.js';
export { isRestricted, resolveBrowserBlock } from './prompts/resolveBrowserBlock.js';
