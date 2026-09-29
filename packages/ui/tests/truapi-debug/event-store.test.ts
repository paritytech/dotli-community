// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for `EventStore.version()`: a monotonic counter a Solid
// adapter can compare against to know when `list()` needs re-reading,
// without diffing the array on every render.

import { describe, expect, it } from 'vitest';
import { EventStore, type TruapiDebugMessageEvent } from '@dotli/truapi-debug';
import type { DotliDebugEvent } from '@dotli/truapi-debug';

function truapiEvent(requestId: string): TruapiDebugMessageEvent {
  return {
    kind: 'truapi',
    direction: 'outgoing',
    requestId,
    payload: { tag: 'example_request', value: { n: 1 } },
  };
}

function dotliEvent(flowId: string): DotliDebugEvent {
  return {
    layer: 'main',
    event: 'heartbeat',
    flowId,
    timestamp: Date.now(),
    payload: { uptimeSec: 1 },
  };
}

describe('EventStore.version()', () => {
  it('starts at 0', () => {
    const store = new EventStore({ capacity: 10 });
    expect(store.version()).toBe(0);
  });

  it('bumps on a truapi insert', () => {
    const store = new EventStore({ capacity: 10 });
    store.insertTruapi(truapiEvent('r1'));
    expect(store.version()).toBe(1);
  });

  it('bumps on a dotli insert', () => {
    const store = new EventStore({ capacity: 10 });
    store.insertDotli(dotliEvent('f1'));
    expect(store.version()).toBe(1);
  });

  it('bumps on clear', () => {
    const store = new EventStore({ capacity: 10 });
    store.insertTruapi(truapiEvent('r1'));
    const afterInsert = store.version();
    store.clear();
    expect(store.version()).toBe(afterInsert + 1);
  });

  it('bumps once per insert that prunes an evicted event', () => {
    const store = new EventStore({ capacity: 2 });
    store.insertTruapi(truapiEvent('r1'));
    store.insertTruapi(truapiEvent('r2'));
    const beforePrune = store.version();
    // Capacity 2: this insert evicts r1's event and prunes it in the
    // same notify — still a single version bump, not two.
    store.insertTruapi(truapiEvent('r3'));
    expect(store.dropped()).toBe(1);
    expect(store.version()).toBe(beforePrune + 1);
  });

  it('does not bump on a paused insert that is dropped', () => {
    const store = new EventStore({ capacity: 10 });
    store.setPaused(true);
    const afterPause = store.version();
    store.insertTruapi(truapiEvent('r1'));
    store.insertDotli(dotliEvent('f1'));
    expect(store.version()).toBe(afterPause);
    expect(store.list()).toHaveLength(0);
  });
});
