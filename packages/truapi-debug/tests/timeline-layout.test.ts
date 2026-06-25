import { describe, expect, it } from "vitest";

import { decodeChainAnnotations } from "../src/chain-decode";
import { isSystemFlowTerminator } from "../src/timeline-layout";
import type { StoredSystemEvent } from "../src/event-store";

function systemEvent(layer: string, event: string): StoredSystemEvent {
  return {
    kind: "system",
    seq: 0,
    receivedAt: 0,
    source: "dotli",
    layer,
    event,
    flowId: "flow",
    payload: {},
  };
}

describe("debug timeline layout", () => {
  it("does not treat login host readiness as a terminal SSO event", () => {
    expect(isSystemFlowTerminator(systemEvent("sso", "login_host_ready"))).toBe(
      false,
    );
    expect(
      isSystemFlowTerminator(systemEvent("sso", "login_request_response")),
    ).toBe(true);
  });

  it("does not infer chain annotations from raw wire payload bytes", () => {
    const annotations = decodeChainAnnotations(
      "remote_chain_head_follow_start",
      { wireId: 1, bytes: new Uint8Array([1, 2, 3]) },
    );

    expect(annotations).toBeNull();
  });
});
