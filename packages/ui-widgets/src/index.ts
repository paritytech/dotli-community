// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the host and the sandbox both mount on their page: the error page, full-page screens, notifications and the lazy
// toast and dialog overlays. Both apps' boot imports this index, so nothing it reaches statically imports Solid.

export {
  createErrorPage,
  renderErrorPageText,
  type ErrorAction,
  type ErrorPageContent,
  type ErrorPageScreen,
} from './error-page/error-page.js';
export { showPageScreen, type PageScreen, type PageSlot, type ScreenSlot } from './page-screen.js';
export { listenForChunkFailures, type ChunkFailureDeps } from './chunk-failures.js';
export type { ShowNotification } from './notification.js';
export type { PresentModal } from './overlays/load.js';
export { createPageOverlays, type PageOverlays } from './page-overlays.js';
