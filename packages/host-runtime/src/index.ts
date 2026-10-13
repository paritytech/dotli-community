// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type { AppVersion, ManifestFacts } from './manifest-facts.js';
export type { AuthCommands } from './auth-commands.js';
export {
  type AuthController,
  type AuthModalPort,
  type AuthModalState,
  type AuthModalView,
  closeAuthModal,
  disableAuthModal,
  initAuthController,
  logout,
  retryLogin,
  startLogin,
} from './auth-controller.js';
export {
  type BlockingModalCoordinator,
  type BlockingModalCounts,
  createBlockingModalCoordinator,
} from './blocking-modal-queue.js';
export { chatStore } from './chat/chat-store.js';
export {
  type ChatBotRecord,
  type ChatChange,
  type ChatConnection,
  type ChatMessageRecord,
  type ChatRepo,
  type ChatRoomRecord,
  type ChatStore,
  type ChatView,
  createChatConnections,
  createChatStore,
} from './chat/store.js';
export type { BridgePorts } from './create-bridge.js';
export { pageDiagnostics } from './diagnostics.js';
export type { DotliAuthState } from './host-callbacks/AuthState.js';
export type { NotificationScheduler } from './host-callbacks/PushNotification.js';
export type { HostCallbackPorts } from './host-callbacks/handlers.js';
export { startSessionState, type TruapiSessionUiState } from './host-callbacks/session-state.js';
export type {
  HostNotice,
  HostNoticeTone,
  HostPrompts,
  PermissionPromptDecision,
  ReviewButton,
  ReviewButtonVariant,
  ReviewDialog,
  ReviewField,
} from './host-prompts.js';
export { type BridgeModule, loadBridge, loadSharedMode } from './lazy.js';
export { type PendingResetTarget, schedulePendingReset, takePendingReset } from './pending-reset.js';
export {
  ALL_PERMISSIONS,
  type EnforceablePermissionName,
  isDevicePermission,
  type PermissionGroup,
  type PermissionStatus,
} from './permissions.js';
export type {
  FrameProduct,
  ProductFrame,
  ProductFrameStatus,
  ProductFrameView,
  TitledProduct,
} from './product-frame.js';
export { phraseToEntropy } from './recovery-phrase.js';
export { dotliVersion, labelToProductId } from './runtime-config.js';
export { createPageScheduledNotifications, type ScheduledNotifications } from './scheduled-notifications.js';
export { getSharedChannel, type SharedChannel } from './shared-mode.js';
export { authStore, getLoggedIn, loggedInStore, setAuthState } from './state/auth.js';
export {
  getProductState,
  productStore,
  setProductError,
  setProductLoaded,
  type ProductDetails,
} from './state/product.js';
export {
  chooseProductPermission,
  onPermissionsChanged,
  type PermissionsChange,
  productPermissionsStore,
  refreshProductPermissions,
  resetProductPermissions,
  startProductPermissions,
} from './state/product-permissions.js';
export { getThemeState, setTheme, type ThemePref, themeStore } from './state/theme.js';
export { walletModeStore } from './state/wallet-mode.js';
export { walletSwitch } from './wallet-switch.js';
