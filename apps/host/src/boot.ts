// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts. A module's imports all run before its own
// body, in import order, and some of main.ts's imports touch the shell as
// they load (offline.ts appends its banner to `#topbar`). Hydrating here
// runs before any of them, so every reference imperative code takes into the
// shell is to a node Solid has claimed. Sentry starts first so that a failed
// hydration, reported by hydrateShell(), reaches it.

import { initSentry, installGlobalErrorHandlers } from "@dotli/metrics/sentry";
import { hydrateShell } from "@dotli/ui/mount/hydrate-shell";

initSentry("host");
installGlobalErrorHandlers("host");
hydrateShell();
