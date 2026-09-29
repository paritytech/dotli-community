// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time entry for apps/host/vite.config.ts, loaded by Node directly,
// hence the `.ts` specifiers. Kept apart from the `@dotli/ui` barrel so no
// browser bundle reaches the Node-only prerender plugin.

export { prerenderPlugin } from './mount/prerender-plugin.ts';

/** Server entry the host prerenders into index.html (exports `renderShell`). */
export const SHELL_SERVER_ENTRY = new URL('./components/shell/shell.server.tsx', import.meta.url).pathname;
