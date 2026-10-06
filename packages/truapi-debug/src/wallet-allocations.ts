// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The experimental wallet's last observed resource allocation outcomes, read
// from captured TrUAPI traffic. Plain functions: the Wallet view in
// `@dotli/ui` decides when to read and how to draw them.

import type { StoredEvent, StoredTruapiEvent } from './event-store.js';
import type { InspectorResource } from './wallet-types.js';

const REQUEST_TAG = 'resource_allocation_request_request';
const RESPONSE_TAG = 'resource_allocation_request_response';

/** A request outcome as last observed, with when it was observed. */
export interface AllocationOutcome {
  status: string;
  at: number;
}

/** Whether `event` is an allocation request or response of `productId`. */
export function isAllocationEvent(event: StoredEvent | undefined, productId: string | undefined): boolean {
  return (
    event?.kind === 'truapi' &&
    event.productId === productId &&
    (event.tag === REQUEST_TAG || event.tag === RESPONSE_TAG)
  );
}

function allocationResources(
  event: StoredTruapiEvent,
  describe: (resource: unknown) => InspectorResource | null,
): (InspectorResource | null)[] | null {
  if (
    event.tag !== REQUEST_TAG ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    !('resources' in event.payload) ||
    !Array.isArray(event.payload.resources)
  ) {
    return null;
  }
  const resources: (InspectorResource | null)[] = [];
  for (const value of event.payload.resources) {
    // Preserve batch indices, including permission resources that are not allowances.
    resources.push(describe(value));
  }
  return resources;
}

function allocationOutcomes(event: StoredTruapiEvent): string[] | null {
  if (
    event.tag !== RESPONSE_TAG ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    !('outcomes' in event.payload) ||
    !Array.isArray(event.payload.outcomes)
  ) {
    return null;
  }
  const results: string[] = [];
  const values: unknown[] = event.payload.outcomes;
  for (const value of values) {
    if (value !== 'Allocated' && value !== 'Rejected' && value !== 'NotAvailable') {
      return null;
    }
    results.push(value);
  }
  return results;
}

/**
 * The product's resources and their latest outcomes: the product's own
 * resources and explicit `outcomes` first, then whatever its allocation
 * traffic from `minimumSeq` on requested and answered.
 */
export function observedAllocations(
  events: readonly StoredEvent[],
  scope: {
    productId: string;
    minimumSeq: number;
    resources: readonly InspectorResource[];
    outcomes: ReadonlyMap<string, AllocationOutcome>;
    describe: (resource: unknown) => InspectorResource | null;
  },
): { resources: InspectorResource[]; results: Map<string, AllocationOutcome> } {
  const resources = new Map(scope.resources.map(resource => [resource.id, resource]));
  const results = new Map(scope.outcomes);
  const requests = new Map<string, (InspectorResource | null)[]>();
  for (const event of events) {
    if (event.kind !== 'truapi' || event.seq < scope.minimumSeq || event.productId !== scope.productId) {
      continue;
    }
    const batch = allocationResources(event, scope.describe);
    if (batch !== null) {
      requests.set(event.requestId, batch);
      for (const resource of batch) {
        if (resource !== null) {
          resources.set(resource.id, resource);
        }
      }
    }
    const statuses = allocationOutcomes(event);
    const requested = requests.get(event.requestId);
    if (statuses === null || requested?.length !== statuses.length) {
      continue;
    }
    requested.forEach((resource, index) => {
      if (resource === null) {
        return;
      }
      const status = statuses[index];
      if (status !== undefined && (results.get(resource.id)?.at ?? 0) <= event.receivedAt) {
        results.set(resource.id, { status, at: event.receivedAt });
      }
    });
  }
  return { resources: Array.from(resources.values()), results };
}
