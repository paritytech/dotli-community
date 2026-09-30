// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The TopbarActionsIsland island of the host page (`@dotli/ui/islands/TopbarActionsIsland`), the
// interactive parts of the shell. One module per island: Astro loads an
// island from the module the page imports it from, so each island loads its
// own code only, when its directive says.
export { TopbarActionsIsland } from '../components/shell/TopbarActionsIsland.js';
