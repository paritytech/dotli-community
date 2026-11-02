// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliDebugEvent } from '@dotli/truapi-debug';

/** One host step of the event union, its layer, event and payload, without the flow and the time it ran at. */
type SystemEventStep = DotliDebugEvent extends infer Event
  ? Event extends DotliDebugEvent
    ? Omit<Event, 'flowId' | 'timestamp'>
    : never
  : never;

export type BuildSystemEventParams = SystemEventStep & {
  flowId?: string;
  timestamp?: number;
};

/** A host event of the step `params` names, in flow `flow-1` at time 0 unless `params` sets them. Never throws. */
export function buildSystemEvent({
  flowId = 'flow-1',
  timestamp = 0,
  ...step
}: BuildSystemEventParams): DotliDebugEvent {
  return { ...step, flowId, timestamp };
}
