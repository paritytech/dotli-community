// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/ui. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export { createBlockingModalCoordinator } from './blocking-modal-queue.js';
export { chainRoleForKey } from './chain-roles.js';
export { showLanding } from './landing/load.js';
export {
  advancePhase,
  initPhases,
  listenForSandboxStatus,
  nudgePhaseProgress,
  onProgressStall,
  onSandboxDone,
  releasePhaseProgress,
  setLoadingDomain,
  setLoadingStage,
  setLoadingWarning,
  stopStatusTick,
  type LoadingPhase,
} from './loading-controller.js';
export { reportIslandErrors } from './mount/islands.js';
export { recordChainPhase, recordPeerCount, recordTransfer, type ChainPhase } from './network-monitor.js';
export { showNotification } from './notification.js';
export { prefetchOverlays } from './overlays/load.js';
export { showPasswordPrompt } from './password-prompt.js';
export { recordRecentLabel } from './recent-labels.js';
export { initScheduledNotifications } from './scheduled-notifications.js';
export { wipeOriginState } from './settings-actions.js';
export { getLoadingState, updateLoading } from './state/loading.js';
export { initSettingsStore } from './state/settings.js';
export { openSettings as openSettingsPanel } from './state/topbar.js';
export { setVerificationShieldState, showLocalhostPill, showProductPill } from './state/url-pill.js';
export { bindTopbar } from './topbar-bar.js';
export { bindUrlPill } from './url-pill.js';
export { armTopbarAutoHide, pinTopbarVisible } from './topbar-autohide.js';
export { initTopBar, setChainsButtonVisible } from './topbar.js';
export { SETTINGS_GLYPH, showError, showErrorPage, showNoContentError } from './ui.js';
export { type ShieldState } from './verification-shield.js';
export {
  loadBridge,
  loadTruapiDebugMount,
  loadSharedMode,
  type BridgeModule,
  type TruapiDebugMountModule,
  type SharedModeModule,
} from './lazy.js';
