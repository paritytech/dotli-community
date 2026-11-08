// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { SystemEventKey, SystemEventPair } from './getSystemEventKey.js';
import { getSystemExplanation } from './getSystemExplanation.js';
import { SYSTEM_EVENT_FACTS, findSystemEventFacts } from './systemEventFacts.js';

/** The host events that close their flow's box on the timeline. */
const FLOW_ENDS: readonly SystemEventKey[] = [
  'boot:ready',
  'boot:landing_page_shown',
  'boot:failed',
  'resolve:completed',
  'resolve:failed',
  'render:iframe_ready',
  'bridge:first_outbound',
  'sandbox:document_written',
  'sandbox:failed',
  'main:monitor_stopped',
];

describe('SYSTEM_EVENT_FACTS', () => {
  it.each(Object.entries(SYSTEM_EVENT_FACTS))(
    'As a dotli developer, I open the explanation of %s and it has a title and a body',
    (_key, facts) => {
      // Given the facts row of the event
      const { explanation } = facts;

      // When I read the title and the body of its explanation
      const { title, body } = explanation;

      // Then neither is empty
      expect(title).not.toBe('');
      expect(body).not.toBe('');
    },
  );

  it.each(Object.entries(SYSTEM_EVENT_FACTS))(
    'As a dotli developer, I see %s close its flow only when it is a flow end',
    (key, facts) => {
      // Given the facts row of the event, and whether it is one of the flow ends
      const isFlowEnd = FLOW_ENDS.some(end => end === key);

      // When I read whether the row says the event ends its flow
      const { endsFlow } = facts;

      // Then it says so only for a flow end
      expect(endsFlow).toBe(isFlowEnd);
    },
  );
});

describe('findSystemEventFacts()', () => {
  it('As a dotli developer, I read the facts of a host event and get its row', () => {
    // Given a host event the union names
    const pair: SystemEventPair = { layer: 'chain', event: 'peers' };

    // When I read its facts
    const facts = findSystemEventFacts(pair);

    // Then I get the row of the table
    expect(facts).toBe(SYSTEM_EVENT_FACTS['chain:peers']);
  });

  it('As a dotli developer, I read the facts of an event the union does not name and get none', () => {
    // Given a sandbox of another release sends an event name this build's union lacks
    const pair = { layer: 'sandbox', event: 'cache_checked' } as unknown as SystemEventPair;

    // When I read its facts and its explanation
    const facts = findSystemEventFacts(pair);

    // Then there are none
    expect(facts).toBeUndefined();
    expect(getSystemExplanation(pair)).toBeUndefined();
  });
});
