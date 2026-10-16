// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Primitives and what the page gives them.
export { Accordion, type AccordionProps } from './components/primitives/Accordion.js';
export { Button, ButtonLink, type ButtonVariant } from './components/primitives/Button.js';
export { Chip } from './components/primitives/Chip.js';
export { IconButton } from './components/primitives/IconButton.js';
export { IconTile } from './components/primitives/IconTile.js';
export { Choice } from './components/primitives/Choice.js';
export { SectionLabel, Stack } from './components/primitives/SectionLabel.js';
export { SegmentedControl, type SegmentOption } from './components/primitives/SegmentedControl.js';
export { StepSlider, type StepSliderProps, type StepSliderStop } from './components/primitives/StepSlider.js';
export { Spinner } from './components/primitives/Spinner.js';
export { StatusDot } from './components/primitives/StatusDot.js';
export { Hint, Surface, SurfaceFoot, SurfaceHead } from './components/primitives/Surface.js';
export { Switch } from './components/primitives/Switch.js';
export { Callout, Row, Well } from './components/primitives/Well.js';
export { Modal } from './components/floating/Modal.js';
export { Popover, usePopover } from './components/floating/Popover.js';
export { Tooltip } from './components/floating/Tooltip.js';
// A row of actions that collapses what does not fit into a More menu.
export { ActionGroup, type ActionGroupMorph, type MoreIds } from './components/actions/ActionGroup.js';
export { ActionItem, type ActionItemProps } from './components/actions/ActionItem.js';
export {
  ActionsContext,
  type ActionAlert,
  type ActionBar,
  type ActionEntry,
} from './components/actions/actions-context.js';
export { PINNED } from './components/actions/fit.js';
export { LayerTracker, ModalFocusFallback, type TrackedLayer } from './components/floating/layer-context.js';
export { useStore } from './components/use-store.js';
export { createDrags, type Drags } from './components/drag.js';
export { focusLostOrInside, focusTrigger } from './components/focus.js';

// Mounting a view inside an error boundary, and the overlays container.
export { ensureOverlayRoot } from './mount/overlay-root.js';
export { RootBoundary } from './mount/root-boundary.js';
export { mountRoot, type MountRootOptions } from './mount/root.js';

// The dialog and toast stores. The overlays render them, and the apps open dialogs and read the toasts.
export {
  openModal,
  refuseModals,
  type ModalButton,
  type ModalButtonVariant,
  type ModalEntry,
  type ModalField,
  type ModalOutcome,
  type ModalView,
} from './page/state/modals.js';
export { toastsStore, type ToastEntry } from './page/state/toasts.js';

// Page helpers.
export { focusables } from './page/focusables.js';
export { preloadWhenIdle, runWhenIdle, type IdleScheduler } from './page/idle.js';
export { isPhoneViewport, watchPhoneViewport } from './page/phone-viewport.js';
export { prefersReducedMotion } from './page/reduced-motion.js';
export type { StatusTone } from './page/status-tone.js';

// The screens and overlays both apps show.
export type { ErrorAction, ErrorPageContent, ErrorText } from './widgets/error-page/error-page.js';
export { showError, showErrorPage, type ShowErrorPage } from './widgets/error-page/show-error-page.js';
export { ErrorDetail, ErrorFrame, type ErrorFrameProps } from './widgets/error-page/ErrorFrame.js';
export { clearScreen, pageContentStore, showScreen, type PageContent } from './widgets/page-screen.js';
export { createReloadOffer, listenForChunkFailures, type ChunkFailureDeps } from './widgets/chunk-failures.js';
export { showNotification, type NotificationParams, type ShowNotification } from './widgets/notification.js';
export { Overlays } from './widgets/overlays/Overlays.js';
