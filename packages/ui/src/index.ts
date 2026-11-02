// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Primitives and what the page gives them.
export type { AccordionProps } from './components/primitives/Accordion.js';
export { Accordion } from './components/primitives/Accordion.js';
export type { ButtonVariant } from './components/primitives/Button.js';
export { Button, ButtonLink } from './components/primitives/Button.js';
export { Chip } from './components/primitives/Chip.js';
export { IconButton } from './components/primitives/IconButton.js';
export { IconTile } from './components/primitives/IconTile.js';
export { Choice } from './components/primitives/Choice.js';
export { SectionLabel, Stack } from './components/primitives/SectionLabel.js';
export type { SegmentOption } from './components/primitives/SegmentedControl.js';
export { SegmentedControl } from './components/primitives/SegmentedControl.js';
export type { StepSliderProps, StepSliderStop } from './components/primitives/StepSlider.js';
export { StepSlider } from './components/primitives/StepSlider.js';
export { Spinner } from './components/primitives/Spinner.js';
export { StatusDot } from './components/primitives/StatusDot.js';
export { Hint, Surface, SurfaceFoot, SurfaceHead } from './components/primitives/Surface.js';
export { Switch } from './components/primitives/Switch.js';
export { Callout, Row, Well } from './components/primitives/Well.js';
export { Modal } from './components/floating/Modal.js';
export { Popover, usePopover } from './components/floating/Popover.js';
export { Tooltip } from './components/floating/Tooltip.js';
// A row of actions that collapses what does not fit into a More menu.
export type { ActionGroupMorph, MoreIds } from './components/actions/ActionGroup.js';
export { ActionGroup } from './components/actions/ActionGroup.js';
export type { ActionItemProps } from './components/actions/ActionItem.js';
export { ActionItem } from './components/actions/ActionItem.js';
export type { ActionAlert, ActionBar, ActionEntry } from './components/actions/actionsContext.js';
export { ActionsContext } from './components/actions/actionsContext.js';
export { PINNED } from './components/actions/fit.js';
export type { TrackedLayer } from './components/floating/layerContext.js';
export { LayerTracker, ModalFocusFallback } from './components/floating/layerContext.js';
export { useStore } from './components/useStore.js';
export type { Drags } from './components/createDrags.js';
export { createDrags } from './components/createDrags.js';
export { focusTrigger, isFocusLostOrInside } from './components/focus.js';

// Mounting a view inside an error boundary, and the overlays container.
export { ensureOverlayRoot } from './mount/overlayRoot.js';
export { RootBoundary } from './mount/rootBoundary.js';
export { mountRoot } from './mount/root.js';

// The dialog and toast stores. The overlays render them, and the apps open dialogs and read the toasts.
export type {
  ModalButton,
  ModalButtonVariant,
  ModalEntry,
  ModalField,
  ModalHandoff,
  ModalOutcome,
  ModalView,
} from './page/state/createModals.js';
export { modals } from './page/state/createModals.js';
export type { ToastEntry } from './page/state/createToasts.js';
export { toasts } from './page/state/createToasts.js';

// Page helpers.
export { focusables } from './page/focusables.js';
export { preloadWhenIdle } from './page/preloadWhenIdle.js';
export { runWhenIdle } from './page/runWhenIdle.js';
export { isPhoneViewport, watchPhoneViewport } from './page/phoneViewport.js';
export { prefersReducedMotion } from './page/reducedMotion.js';
export type { StatusTone } from './page/statusTone.js';

// The screens and overlays both apps show.
export type { ErrorAction, ErrorPageContent, ErrorText } from './widgets/errorPage/arrangeErrorActions.js';
export { showError } from './widgets/errorPage/showError.js';
export type { ShowErrorPage } from './widgets/errorPage/showErrorPage.js';
export { showErrorPage } from './widgets/errorPage/showErrorPage.js';
export type { ErrorFrameProps } from './widgets/errorPage/ErrorFrame.js';
export { ErrorDetail, ErrorFrame } from './widgets/errorPage/ErrorFrame.js';
export type { PageContent } from './widgets/createPageScreen.js';
export { pageScreen } from './widgets/createPageScreen.js';
export { createReloadOffer } from './widgets/createReloadOffer.js';
export { listenForChunkFailures } from './widgets/listenForChunkFailures.js';
export type { NotificationParams, ShowNotification } from './widgets/createNotifier.js';
export { showNotification } from './widgets/createNotifier.js';
export { Overlays } from './widgets/overlays/Overlays.js';
