// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Building blocks that show domain data: one entity or one small control each. They take accessors and callbacks as
// props and read no store or data source. The flows that compose them live in the app.

export type { AccountSession } from './account/account.js';
export { AccountAvatar } from './account/AccountAvatar.js';
export { sessionDisplayName, sessionInitials, sessionUsername } from './account/account-names.js';
export type { BarHealth, ChainBar, ChainSummary, ChainUse } from './chains/chain.js';
export { HISTORY_SLOTS } from './chains/chain-strip.js';
export { ChainGroup } from './chains/ChainGroup.js';
export { healthWord, type NetworkHealth } from './chains/network-health.js';
export { ContactIcon } from './chat/ContactIcon.js';
export { ContactRow } from './chat/ContactRow.js';
export { chatUnreadLabel } from './chat/unread.js';
export { type CustomActionHandler, CustomNode } from './chat/CustomNode.js';
export type { ChatMessage } from './chat/message.js';
export { type CustomBody, MessageBubble } from './chat/MessageBubble.js';
export { ResizeHandle } from './chat/ResizeHandle.js';
export { permissionIcon } from './permissions/permission-icons.js';
export { PermissionRow } from './permissions/PermissionRow.js';
export type { PermissionEntry, PermissionName, PermissionStatus } from './permissions/permissions.js';
export { AppearancePicker } from './settings/Appearance.js';
export type { ThemeChoice } from './settings/settings.js';
// Domain icons, each a Solid component in the current text color.
export { TrustedShieldIcon } from './icons/TrustedShieldIcon.js';
export { UserIcon } from './icons/UserIcon.js';
export { VerifiedShieldIcon } from './icons/VerifiedShieldIcon.js';
