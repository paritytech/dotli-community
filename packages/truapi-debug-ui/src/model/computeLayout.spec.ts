// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { describe, expect, it } from 'vitest';
import { buildSystemEvent } from '../testing/buildSystemEvent.js';
import { buildTruapiEvent } from '../testing/buildTruapiEvent.js';
import { BOOT_STARTED } from '../testing/constants.js';
import { computeGlobalYPositions } from './computeGlobalYPositions.js';
import { computeLayout, type SegmentEntry } from './computeLayout.js';
import { createEventStore } from './createEventStore.js';

/** The timeline box of a host flow that began with a boot start and went on to `end`. */
function layoutFlow(end: DotliDebugEvent): SegmentEntry | undefined {
  const store = createEventStore({ capacity: 10 });
  store.insertDotli(buildSystemEvent(BOOT_STARTED));
  store.insertDotli(end);
  const events = store.list();
  return computeLayout(events, computeGlobalYPositions(events)).segments[0];
}

describe('debug panel timeline of host flows', () => {
  it.each<{ story: string; end: DotliDebugEvent; pending: boolean }>([
    {
      story: 'that failed to resolve as finished',
      end: buildSystemEvent({
        layer: 'resolve',
        event: 'failed',
        timestamp: 1,
        payload: { label: 'app', source: 'smoldot', reason: 'no peers' },
      }),
      pending: false,
    },
    {
      story: 'whose last step does not end it as pending',
      end: buildSystemEvent({ layer: 'boot', event: 'topbar_ready', timestamp: 1, payload: {} }),
      pending: true,
    },
    {
      story: 'that reached an event the union does not name as pending',
      // A sandbox of another release sends a name the union lacks.
      end: {
        layer: 'sandbox',
        event: 'archive_failed',
        flowId: 'flow-1',
        timestamp: 1,
        payload: {},
      } as unknown as DotliDebugEvent,
      pending: true,
    },
  ])('As a dotli developer, I see a host flow $story on the timeline', ({ end, pending }) => {
    // Given a host flow that began with a boot start and whose last step is the row's event

    // When the timeline lays the flow out
    const segment = layoutFlow(end);

    // Then its box is pending or finished, as the row says
    expect(segment).toMatchObject({ pending });
  });
});

describe('debug panel timeline of chain operations', () => {
  it('As a dotli developer whose first follow subscription was evicted, I see a finished operation linked to the rail of the subscription it ran on', () => {
    // Given three follows of one chain, the first evicted, and a body operation on the second that has finished
    const genesisHash = `0x${'ab'.repeat(32)}`;
    const store = createEventStore({ capacity: 5 });
    for (const requestId of ['follow-0', 'follow-1', 'follow-2']) {
      store.insertTruapi(
        buildTruapiEvent({ tag: 'remote_chain_head_follow_start', requestId, value: { genesisHash } }),
      );
    }
    store.insertTruapi(
      buildTruapiEvent({
        tag: 'remote_chain_head_body_request',
        requestId: 'body',
        value: { genesisHash, followSubscriptionId: 'follow_1', hash: '0x01' },
      }),
    );
    store.insertTruapi(
      buildTruapiEvent({
        tag: 'remote_chain_head_body_response',
        requestId: 'body',
        direction: 'incoming',
        value: { success: true, value: { tag: 'Started', value: { operationId: 'op-1' } } },
      }),
    );
    store.insertTruapi(
      buildTruapiEvent({
        tag: 'remote_chain_head_follow_receive',
        requestId: 'follow-1',
        direction: 'incoming',
        value: { tag: 'OperationBodyDone', value: { operationId: 'op-1', value: [] } },
      }),
    );
    const events = store.list();

    // When the timeline lays the events out
    const { rails, segments } = computeLayout(events, computeGlobalYPositions(events));

    // Then the operation's box links to the second subscription's rail
    const rail = rails.find(candidate => candidate.seqAnchor === 1);
    expect(segments[0]?.linkedRailIndex).toBe(rail?.railIndex);
  });

  it("As a dotli developer running two products whose calls share a request id, I see the second product's call as its own box", () => {
    // Given one product's follow subscription and another product's call under the same request id
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(
      buildTruapiEvent({
        tag: 'remote_chain_head_follow_start',
        requestId: '5',
        productId: 'one.dot',
        value: { genesisHash: `0x${'ab'.repeat(32)}` },
      }),
    );
    store.insertTruapi(buildTruapiEvent({ tag: 'sign_request', requestId: '5', productId: 'two.dot' }));
    const events = store.list();

    // When the timeline lays the events out
    const { segments } = computeLayout(events, computeGlobalYPositions(events));

    // Then the second product's call has its own box
    expect(segments.map(segment => segment.seqAnchor)).toEqual([1]);
  });

  it("As a dotli developer running two products whose operations share an operation id, I see only the finished one's box end", () => {
    // Given two products that each start a body operation the node numbers op-1, and only the first one's finishes
    const genesisHash = `0x${'ab'.repeat(32)}`;
    const store = createEventStore({ capacity: 20 });
    for (const productId of ['one.dot', 'two.dot']) {
      store.insertTruapi(
        buildTruapiEvent({
          tag: 'remote_chain_head_follow_start',
          requestId: 'follow',
          productId,
          value: { genesisHash },
        }),
      );
      store.insertTruapi(
        buildTruapiEvent({
          tag: 'remote_chain_head_body_request',
          requestId: 'body',
          productId,
          value: { genesisHash, followSubscriptionId: 'follow_0', hash: '0x01' },
        }),
      );
      store.insertTruapi(
        buildTruapiEvent({
          tag: 'remote_chain_head_body_response',
          requestId: 'body',
          productId,
          direction: 'incoming',
          value: { success: true, value: { tag: 'Started', value: { operationId: 'op-1' } } },
        }),
      );
    }
    store.insertTruapi(
      buildTruapiEvent({
        tag: 'remote_chain_head_follow_receive',
        requestId: 'follow',
        productId: 'one.dot',
        direction: 'incoming',
        value: { tag: 'OperationBodyDone', value: { operationId: 'op-1', value: [] } },
      }),
    );
    const events = store.list();

    // When the timeline lays the events out
    const { segments } = computeLayout(events, computeGlobalYPositions(events));

    // Then the first product's box has ended and the second product's box still waits
    expect(segments.map(segment => segment.pending)).toEqual([false, true]);
  });
});
