// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the sandbox's boot leaves them out.

// The views' types come from their loaders, since the boot zone refuses even a type-only import of them.
/** Only encrypted content asks for a password. */
export const loadPasswordDialog = () => import('./password-dialog.js');
export type PasswordDialogModule = Awaited<ReturnType<typeof loadPasswordDialog>>;

/** Only a retry after a failed load shows it. */
export const loadRetryScreen = () => import('./RetryScreen.js');
export type RetryScreenModule = Awaited<ReturnType<typeof loadRetryScreen>>;
