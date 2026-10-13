// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';

/** Delivers to every listener, so one that throws cannot silence the rest. */
export function broadcast<T>(listeners: Iterable<(event: T) => void>, event: T, label: string): void {
  // A snapshot, so a listener added or removed by a listener does not change who hears this event.
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err: unknown) {
      log.error(`[dot.li protocol] ${label} listener threw:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Adds a listener and returns its removal. Wrapped, so one listener added twice is two subscriptions, as each removal
 * expects.
 */
export function addListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): () => void {
  const wrapped = (event: T): void => {
    listener(event);
  };
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}
