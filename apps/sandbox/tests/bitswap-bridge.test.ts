import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestBitswapBlock } from "../src/bitswap-bridge";

/**
 * Drives the host side of the relay: captures what the bridge posts to its
 * parent, and lets a test answer as the host would.
 */
function hostSide(): { posted: unknown[] } {
  const posted: unknown[] = [];
  vi.spyOn(window, "parent", "get").mockReturnValue({
    postMessage: (message: unknown) => {
      posted.push(message);
    },
  } as unknown as Window);
  return { posted };
}

/**
 * happy-dom's `PageTransitionEvent` constructor accepts `persisted` and then
 * reports it as `undefined`, so the flag has to be attached directly for the
 * handler's guard to see anything.
 */
function pagehide(persisted: boolean): void {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

function abortMessages(posted: unknown[]): { ids: string[] }[] {
  return posted.filter(
    (m): m is { type: string; ids: string[] } =>
      typeof m === "object" &&
      m !== null &&
      (m as { type?: unknown }).type === "dotli:bitswap-abort",
  );
}

describe("sandbox bitswap bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("As a user, leaving the page tells the host to stop fetching for it", async () => {
    // Given a block request the host has not answered
    const host = hostSide();
    const pending = requestBitswapBlock("bafyX");
    const settled = expect(pending).rejects.toThrow(/aborted/);

    // When the frame goes away for good
    pagehide(false);

    // Then the host was told which fetches to drop
    await settled;
    const aborts = abortMessages(host.posted);
    expect(aborts).toHaveLength(1);
    expect(aborts[0].ids).toHaveLength(1);
  });

  it("As a user, a page kept in the back/forward cache is not cancelled behind its back", async () => {
    // Given a block request still open as the page is frozen rather than closed
    const host = hostSide();
    const pending = requestBitswapBlock("bafyY");
    let settledEarly = false;
    void pending.catch(() => {
      settledEarly = true;
    });

    // When the frame is only being cached, so it can come back
    pagehide(true);
    await Promise.resolve();

    // Then nothing was cancelled, because a restored frame would be left
    // awaiting a fetch the host had already abandoned
    expect(abortMessages(host.posted)).toHaveLength(0);
    expect(settledEarly).toBe(false);
  });

  it("As a user, a torn-down fetch rejects rather than hanging the frame", async () => {
    // Given an open request
    hostSide();
    const pending = requestBitswapBlock("bafyZ");

    // When the frame is torn down
    pagehide(false);

    // Then the awaiting archive walk unwinds, and the message says "aborted"
    // so the host treats it as a teardown rather than a failed load
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("As an operator, a teardown with nothing in flight stays silent", async () => {
    // Given no outstanding requests
    const host = hostSide();

    // When the frame goes away
    pagehide(false);

    // Then the host is not messaged at all
    await Promise.resolve();
    expect(abortMessages(host.posted)).toHaveLength(0);
  });
});
