// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts. A module's imports all run before its own
// body, in import order, so an import of main.ts that touched the shell as
// it loaded would run before main.ts could hydrate it. Hydrating here runs
// before any of them, so every reference imperative code takes into the
// shell is to a node Solid has claimed. Sentry starts first so that a failed
// hydration, reported by hydrateShell(), reaches it. The shell's islands
// (its reactive pieces) start loading right after, off the startup bundle;
// they mount over the static markup when their chunk arrives.

import { initSentry, installGlobalErrorHandlers } from "@dotli/metrics/sentry";
import { hydrateShell } from "@dotli/ui/mount/hydrate-shell";
import { ensureIslands } from "@dotli/ui/mount/load-islands";

initSentry("host");
installGlobalErrorHandlers("host");
hydrateShell();
void ensureIslands();
