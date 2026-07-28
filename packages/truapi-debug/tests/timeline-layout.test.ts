// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { EventStore } from "../src/event-store.ts";
import { partitionIntoSwimlanes } from "../src/timeline-layout.ts";
import type { TruapiDebugMessageEvent } from "../src/event-store.ts";

const genesisHash = `0x${"11".repeat(32)}`;

function truapiEvent(
  requestId: string,
  tag: string,
  value: unknown,
  direction: "incoming" | "outgoing" = "incoming",
): TruapiDebugMessageEvent {
  return {
    kind: "truapi",
    direction,
    productId: "myapp.dot",
    requestId,
    payload: { tag, value },
  };
}

describe("partitionIntoSwimlanes", () => {
  it("As a dotli integrator, the host forms a chain swimlane from decoded follow traffic", () => {
    // Given: a follow subscription plus a header op, as the tap now emits them.
    const store = new EventStore({ capacity: 100 });
    store.insertTruapi(
      truapiEvent("req-follow", "remote_chain_head_follow_start", {
        tag: "V1",
        value: { genesisHash, withRuntime: true },
      }),
    );
    store.insertTruapi(
      truapiEvent(
        "req-follow",
        "remote_chain_head_follow_receive",
        { tag: "V1", value: { tag: "Initialized", value: {} } },
        "outgoing",
      ),
    );
    store.insertTruapi(
      truapiEvent("req-header", "remote_chain_head_header_request", {
        tag: "V1",
        value: {
          genesisHash,
          followSubscriptionId: "follow_0",
          hash: `0x${"22".repeat(32)}`,
        },
      }),
    );

    // When
    const lanes = partitionIntoSwimlanes(store.list());

    // Then: a dedicated chain lane exists and holds all three events.
    const chainLane = lanes.find((lane) => lane.key === `chain-${genesisHash}`);
    expect(chainLane).toBeDefined();
    expect(chainLane?.events).toHaveLength(3);
  });

  it("As a dotli integrator, the host keeps unnamed non-chain frames in the Other lane", () => {
    // Given
    const store = new EventStore({ capacity: 100 });
    store.insertTruapi(
      truapiEvent("req-sys", "system_handshake_request", {
        wireId: 0,
        bytes: new Uint8Array(),
      }),
    );

    // When
    const lanes = partitionIntoSwimlanes(store.list());

    // Then
    const other = lanes.find((lane) => lane.key === "other");
    expect(other?.events).toHaveLength(1);
  });
});
