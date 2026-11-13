// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildTruapiEvent } from '../testing/buildTruapiEvent.js';
import { createEventStore } from './createEventStore.js';
import { partitionIntoSwimlanes } from './partitionIntoSwimlanes.js';

const FOLLOWED = `0x${'ab'.repeat(32)}`;
const UNFOLLOWED = `0x${'cd'.repeat(32)}`;

describe('debug panel timeline swimlanes', () => {
  it.each([
    { story: 'a followed chain in its own lane', genesisHash: FOLLOWED, lane: `chain-${FOLLOWED}` },
    { story: 'a chain the product never followed under other', genesisHash: UNFOLLOWED, lane: 'other' },
  ])('As a dotli developer, I see a call to $story', ({ genesisHash, lane }) => {
    // Given the product follows one chain and reads the header of a chain
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(
      buildTruapiEvent({
        tag: 'remote_chain_head_follow_start',
        requestId: 'follow',
        value: { genesisHash: FOLLOWED },
      }),
    );
    store.insertTruapi(
      buildTruapiEvent({ tag: 'remote_chain_head_header_request', requestId: 'header', value: { genesisHash } }),
    );

    // When the timeline splits the events into lanes
    const lanes = partitionIntoSwimlanes(store.list());

    // Then the header call sits in the lane the row names
    const headerLane = lanes.find(candidate => candidate.events.some(event => event.seq === 1));
    expect(headerLane?.key).toBe(lane);
  });

  it("As a dotli developer running two products whose calls share a request id, I see one product's call keep out of the other's chain lane", () => {
    // Given one product follows a chain, and another product sends a chain message under the follow's request id
    const store = createEventStore({ capacity: 10 });
    store.insertTruapi(
      buildTruapiEvent({
        tag: 'remote_chain_head_follow_start',
        requestId: '5',
        productId: 'one.dot',
        value: { genesisHash: FOLLOWED },
      }),
    );
    store.insertTruapi(
      buildTruapiEvent({ tag: 'remote_chain_head_follow_receive', requestId: '5', productId: 'two.dot', value: {} }),
    );

    // When the timeline splits the events into lanes
    const lanes = partitionIntoSwimlanes(store.list());

    // Then the second product's message sits under other
    const lane = lanes.find(candidate => candidate.events.some(event => event.seq === 1));
    expect(lane?.key).toBe('other');
  });
});
