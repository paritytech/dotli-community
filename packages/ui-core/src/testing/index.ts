// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fakes other packages' tests drive the page stores and helpers with. Never imported by shipped code.

// The modal store presents a dialog without the overlays, so a spec answers it in their place.
export { modalsStore, resetModalsForTests } from '../state/modals.js';
export { chooseModalButton, dismissModal, shownModal } from '../state/modals.fake.js';
export { PHONE_QUERY, resetPhoneViewport } from '../phone-viewport.js';
// The toast store on a page whose visibility a spec flips (`FakePage` from `@dotli/shared/testing`), for the notifier
// and the overlays over it.
export { bindToastPage, resetToastsForTests } from '../state/toasts.js';
// A reporter that records, for a spec or story to read what was reported.
export { createRecordingReporter, type RecordingReporter } from '../report.fake.js';
