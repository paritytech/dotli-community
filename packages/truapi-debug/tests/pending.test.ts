// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  callKeyOf,
  formatPending,
  openCalls,
  pendingKeyOf,
} from "@dotli/truapi-debug/pending";
import type {
  StoredSystemEvent,
  StoredTruapiEvent,
} from "@dotli/truapi-debug/event-store";

const T0 = 1_000_000;

let nextSeq = 0;

function call(
  tag: string,
  requestId: string,
  at: number,
  direction: "incoming" | "outgoing" = "incoming",
  productId: string | undefined = "host-playground",
): StoredTruapiEvent {
  return {
    kind: "truapi",
    seq: nextSeq++,
    receivedAt: at,
    direction,
    productId,
    requestId,
    tag,
    payload: {},
  };
}

function systemEvent(at: number): StoredSystemEvent {
  return {
    kind: "system",
    seq: nextSeq++,
    receivedAt: at,
    source: "dotli",
    layer: "resolve",
    event: "started",
    flowId: "f1",
    payload: {},
  };
}

describe("openCalls", () => {
  it("As a developer, a request the host never answered stays outstanding", () => {
    // Given a request with no reply
    const events = [call("account_get_account_request", "p:2", T0)];

    // When outstanding calls are collected
    const open = openCalls(events);

    // Then the call is listed, timed from when the request went out
    expect(open.get("host-playground::p:2")).toBe(T0);
  });

  it("As a developer, a request stops being outstanding once its reply lands", () => {
    // Given a request answered 4.4 seconds later
    const events = [
      call("resource_allocation_request_request", "p:366", T0),
      call(
        "resource_allocation_request_response",
        "p:366",
        T0 + 4400,
        "outgoing",
      ),
    ];

    // When outstanding calls are collected
    const open = openCalls(events);

    // Then nothing is outstanding
    expect(open.size).toBe(0);
  });

  it("As a developer, two products on the same request id do not cancel each other", () => {
    // Given alpha answered on p:1 and beta still waiting on p:1
    const events = [
      call("account_get_account_request", "p:1", T0, "incoming", "alpha"),
      call("account_get_account_response", "p:1", T0 + 10, "outgoing", "alpha"),
      call("account_get_account_request", "p:1", T0, "incoming", "beta"),
    ];

    // When outstanding calls are collected
    const open = openCalls(events);

    // Then only beta is outstanding
    expect([...open.keys()]).toEqual(["beta::p:1"]);
  });

  it("As a developer, the request time survives a retried request on one id", () => {
    // Given the same call id seen twice with no reply
    const events = [
      call("account_get_account_request", "p:9", T0),
      call("account_get_account_request", "p:9", T0 + 5000),
    ];

    // When outstanding calls are collected
    const open = openCalls(events);

    // Then the wait is measured from the first attempt, not the latest
    expect(open.get("host-playground::p:9")).toBe(T0);
  });

  it("As a developer, host lifecycle events are not calls", () => {
    // Given only system events
    const open = openCalls([systemEvent(T0)]);

    // Then nothing is outstanding
    expect(open.size).toBe(0);
  });

  it("As a developer, a call with no product id is still tracked", () => {
    // Given a host-scoped call. Built inline because passing `undefined` to
    // the helper would trigger its default rather than clear the field.
    const events = [
      {
        ...call("account_request_login_request", "dotli:", T0),
        productId: undefined,
      },
    ];

    // When outstanding calls are collected
    const open = openCalls(events);

    // Then it is keyed under the host rather than dropped
    expect(open.get("dotli::dotli:")).toBe(T0);
  });
});

describe("pendingKeyOf", () => {
  it("As a developer, only request rows carry a badge", () => {
    expect(pendingKeyOf(call("x_request", "p:1", T0))).toBe(
      "host-playground::p:1",
    );
    expect(pendingKeyOf(call("x_response", "p:1", T0, "outgoing"))).toBeNull();
    expect(pendingKeyOf(systemEvent(T0))).toBeNull();
  });

  it("As a developer, a row's badge key matches the key its call is tracked under", () => {
    // Given a request row
    const ev = call("x_request", "p:7", T0);

    // Then the badge looks the call up under exactly the key openCalls used
    expect(pendingKeyOf(ev)).toBe(callKeyOf(ev));
    expect(openCalls([ev]).has(callKeyOf(ev))).toBe(true);
  });
});

describe("formatPending", () => {
  it("As a developer, sub-second waits read in milliseconds and longer ones in seconds", () => {
    expect(formatPending(940)).toBe("940ms");
    expect(formatPending(1000)).toBe("1.0s");
    expect(formatPending(30_200)).toBe("30.2s");
  });
});
