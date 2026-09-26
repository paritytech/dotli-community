// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A server entry whose component throws, for render-hydratable.test.ts.

import { renderHydratableToString } from "@dotli/ui/mount/render-hydratable";

function Broken(): never {
  throw new Error("the shell is broken: missing store default");
}

export function renderBroken(): string {
  return renderHydratableToString(() => <Broken />, "broken");
}
