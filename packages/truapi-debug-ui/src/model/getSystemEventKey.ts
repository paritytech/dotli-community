// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliDebugEvent } from '@dotli/truapi-debug';

/** A system event's layer with one of that layer's own events. */
export type SystemEventPair = PickPair<DotliDebugEvent>;

/** The `layer:event` key of one system event. */
export type SystemEventKey = FormatKey<SystemEventPair>;

/** Distributes over the union, so each member keeps its own layer with its own events. */
type PickPair<Member> = Member extends DotliDebugEvent ? Pick<Member, 'layer' | 'event'> : never;

type FormatKey<Pair> = Pair extends SystemEventPair ? `${Pair['layer']}:${Pair['event']}` : never;

/** The `layer:event` key a system event is matched by. Never throws. */
export function getSystemEventKey(pair: SystemEventPair): SystemEventKey {
  // A template literal over a union widens to every layer with every event, which no pair carries.
  return `${pair.layer}:${pair.event}` as SystemEventKey;
}

/** The layer and event of a debug event, as one typed pair. Never throws. */
export function toSystemEventPair(event: DotliDebugEvent): SystemEventPair {
  // Building the two fields separately widens them to every layer with every event.
  return { layer: event.layer, event: event.event } as SystemEventPair;
}
