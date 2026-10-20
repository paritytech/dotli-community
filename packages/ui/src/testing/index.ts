// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fakes other packages' tests drive ui with. Never imported by shipped code.

export { settle } from './settle.js';
// Functional tests and story plays query and wait on the page through these.
export { appears, byId, byTestId, query } from './queries.dom.js';
// Functional tests under happy-dom install it from their setup file.
export { installPopoverPolyfill } from './popover-polyfill.dom.js';
// The modal store presents a dialog without the overlays, so a spec answers it in their place.
export { modalsStore, settleModal } from '../page/state/modals.js';
export { chooseModalButton, dismissModal, shownModal } from '../page/state/modals.fake.js';
export { PHONE_QUERY } from '../page/phone-viewport.js';
// The toast store, bound to the document of a `FakePage` (from `@dotli/shared/testing`) whose visibility a spec flips.
export { bindToastPage } from '../page/state/toasts.js';
