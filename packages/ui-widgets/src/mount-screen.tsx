// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { mountRoot } from '@dotli/ui';
import type { JSX } from '@solidjs/web';
import type { ScreenSlot } from './page-screen.js';

/** Mounts a full-page screen's view in place of what its slot held, as the content root the slot names. */
export function mountScreen(slot: ScreenSlot, view: () => JSX.Element): void {
  slot.app.replaceChildren();
  mountRoot(slot.root, slot.app, view, { report: slot.report, onBroken: slot.onBroken, content: true });
}
