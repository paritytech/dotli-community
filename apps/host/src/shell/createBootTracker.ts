// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Boot runs before the resolution trace exists, so this says where a boot failure happened.

/** Where a boot is. The values tag boot-failure reports. */
export type BootStep =
  'start' | 'url_settings' | 'bridge_load' | 'topbar' | 'localhost_render' | 'preview_render' | 'resolve_setup';

/** Builds a tracker at `start`. */
export function createBootTracker() {
  let step: BootStep = 'start';

  function setStep(next: BootStep): void {
    step = next;
  }

  return {
    /** Records the step the boot enters. Never throws. */
    setStep,
    /** Returns the step the boot entered last, `start` before any. Never throws. */
    getStep: (): BootStep => step,
  };
}

/** The page's boot. */
export const bootTracker = createBootTracker();
