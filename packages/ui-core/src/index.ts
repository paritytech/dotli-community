// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How ui reports the failures it recovers from. The app passes its metrics in, at a mount or an island.
export type { ExpectedContext, FailureContext, ReportExpected, Reporter, ReportFailure } from './report.js';

// The page's roots, which a full-page screen or a lazy overlay mounts into and disposes.
export { disposeAppRoot, disposeContentRoots, registerAppRoot, type AppRootOptions } from './roots/app-roots.js';
export { createLazyRoot } from './roots/lazy-root.js';

// The dialog and toast stores. The overlays render them and everything else opens, pushes and settles through them.
export {
  failAllModals,
  modalsStore,
  openModal,
  settleModal,
  type ModalButton,
  type ModalButtonVariant,
  type ModalEntry,
  type ModalOptions,
  type ModalOutcome,
  type ModalView,
} from './state/modals.js';
export {
  clearToasts,
  dismissAllToasts,
  dismissToast,
  pushToast,
  removeToast,
  setToastsExpanded,
  toastsStore,
  type ToastEntry,
  type ToastInput,
} from './state/toasts.js';

// Page helpers.
export { focusables } from './focusables.js';
export { preloadWhenIdle, type IdleScheduler } from './idle.js';
export { isPhoneViewport, watchPhoneViewport } from './phone-viewport.js';
export { prefersReducedMotion } from './reduced-motion.js';

// The status colours, and the type of the icon a toast or dialog carries.
export type { StatusTone } from './status-tone.js';
export type { IconComponent } from './icon.js';
