// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled, type Accessor } from 'solid-js';

/** What makes the permissions re-read (and the button its class). */
export const REFRESH_EVENTS = [
  'dotli:product-loaded',
  'dotli:product-error',
  'dotli:permission-changed',
  'dotli:device-permission-changed',
] as const;

/**
 * A count that moves on each event that may change the permissions, while
 * the calling component is mounted. Reads that key on it next to the
 * product's label run again even for the product already on show.
 */
export function createPermissionChanges(): Accessor<number> {
  const [changes, setChanges] = createSignal(0);
  const refresh = (): void => {
    setChanges(n => n + 1);
  };
  // Once mounted: a build-time render has no window.
  onSettled(() => {
    for (const name of REFRESH_EVENTS) {
      window.addEventListener(name, refresh);
    }
    return () => {
      for (const name of REFRESH_EVENTS) {
        window.removeEventListener(name, refresh);
      }
    };
  });
  return changes;
}
