// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { disposeAppRoot } from '@dotli/ui-core';
import { createRecordingReporter, resetModalsForTests, resetToastsForTests } from '@dotli/ui-core/testing';
import { settle } from '@dotli/ui/testing';
import { createPageOverlays } from '../../src/page-overlays.js';

/** The page's overlays as an app creates them, reporting to a recorder. */
export const overlays = createPageOverlays(createRecordingReporter());

export async function overlaysReady(): Promise<void> {
  await overlays.ensure();
  await settle();
}

export function resetOverlays(): void {
  disposeAppRoot('overlays');
  overlays.reset();
  resetModalsForTests();
  resetToastsForTests();
  document.getElementById('overlay-root')?.remove();
}
