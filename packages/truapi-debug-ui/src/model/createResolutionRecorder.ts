// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliDebugEvent } from '@dotli/truapi-debug';

/** Holds only a load's host events, so other traffic never pushes out its early phases. */
export type ResolutionRecorder = ReturnType<typeof createResolutionRecorder>;

const KEPT_LAYERS: ReadonlySet<DotliDebugEvent['layer']> = new Set([
  'boot',
  'resolve',
  'render',
  'chain',
  'sandbox',
  'failover',
]);

const RECORDER_CAPACITY = 4000;

/** Records the host events of the load phases, keeping the newest up to a fixed cap. */
export function createResolutionRecorder() {
  const kept: DotliDebugEvent[] = [];
  let version = 0;
  return {
    /** Keeps `event` when its layer belongs to a load phase, dropping the oldest past the cap. Never throws. */
    record(event: DotliDebugEvent): void {
      if (!KEPT_LAYERS.has(event.layer)) {
        return;
      }
      kept.push(event);
      // A slice would copy every retained event on each record once full.
      if (kept.length > RECORDER_CAPACITY) {
        kept.shift();
      }
      version++;
    },
    /** Drops every kept event. Never throws. */
    clear(): void {
      kept.length = 0;
      version++;
    },
    /**
     * The kept events, oldest first. The same array for the recorder's lifetime, trimmed in place, so do not keep it.
     * Never throws.
     */
    events(): readonly DotliDebugEvent[] {
      return kept;
    },
    /** A count bumped on every change, so a view redraws only when the kept events changed. Never throws. */
    version(): number {
      return version;
    },
  };
}
