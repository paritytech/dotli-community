// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the host and the sandbox both show on their page: the error page and its frame, full-page screens,
// notifications and the toast and dialog overlays.

export type { ErrorAction, ErrorPageContent, ErrorText } from './error-page/error-page.js';
export { showError, showErrorPage, type ShowErrorPage } from './error-page/show-error-page.js';
export { ErrorDetail, ErrorFrame, type ErrorFrameProps } from './error-page/ErrorFrame.js';
export { clearScreen, pageContentStore, showScreen, type PageContent } from './page-screen.js';
export { listenForChunkFailures, offerReload, type ChunkFailureDeps } from './chunk-failures.js';
export { showNotification, type ShowNotification } from './notification.js';
export { Overlays } from './overlays/Overlays.js';
