// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the sandbox's boot leaves them out.

/** Only encrypted content asks for a password. */
export const loadPasswordDialog = () => import('./password-dialog.js');
export type PasswordDialogModule = Awaited<ReturnType<typeof loadPasswordDialog>>;

/** Only a checker build injects it. */
export const loadSandboxChecker = () => import('./inject-checker.js');
