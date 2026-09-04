// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Remote chain provider connection lifecycle, queuing, and message delivery.
 *
 * Verifies that dApps opening chain connections before the shared frame is ready
 * have their requests queued and delivered upon connection completion, that
 * chain replies route back to the correct client, and that connection failures
 * cleanly surface errors to the consumer within connection time limits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_ID } from "@dotli/config/config";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import {
  createRemoteChainProvider,
  getProtocolOrigin,
  isRemoteChainSupported,
  resetProtocolFrame,
  subscribeSharedAuthStorage,
} from "@dotli/protocol/client";
import {
  createTestDApp,
  elapse,
  installProtocolFrame,
  Rpc,
  until,
  type ProtocolFrame,
} from "./support";

describe("Remote chain provider lifecycle and request routing", () => {
  let frame: ProtocolFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    frame = installProtocolFrame();
  });

  afterEach(() => {
    resetProtocolFrame();
    frame.restore();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("As a dApp opening a chain connection while the frame is still starting up, I am told the connection failed inside the time a connection is promised", async () => {
    // Given
    const dApp = createTestDApp();
    frame.open();
    await elapse(1);

    // When
    dApp.send(Rpc.request(7));

    // Then
    await until(() => dApp.replies().length > 0, 30_000);
    expect(dApp.lastReply()).toMatchObject(Rpc.error(7));
  });

  it("As a dApp whose chain connection opens while the frame is starting, my queued request is delivered and its answer reaches me", async () => {
    // Given
    const dApp = createTestDApp();
    dApp.send(Rpc.request(7));

    // When
    await frame.bootAndConnect();

    // Then
    expect(frame.sentRpcRequests()).toContainEqual(Rpc.request(7));

    // And When
    dApp.send(Rpc.request(8, "chain_getHeader"));
    await elapse(1);
    expect(frame.sentRpcRequests()).toHaveLength(2);

    frame.chainMessage(frame.connectionId(), Rpc.response(7, "0xblock"));
    await elapse(1);
    expect(dApp.replies()).toEqual([Rpc.response(7, "0xblock")]);
  });

  it("As a dApp whose queued request cannot be delivered, I am answered with an error rather than left waiting", async () => {
    // Given
    const dApp = createTestDApp();
    dApp.send(Rpc.request(9));

    // When
    await frame.bootAndConnect();
    expect(frame.sentRpcRequests()).toHaveLength(1);

    // Then
    await until(() => dApp.replies().length > 0, 30_000);
    expect(dApp.lastReply()).toMatchObject(Rpc.error(9));
  });

  it("refuses to create a provider for an unsupported genesis hash", () => {
    const invalidGenesis =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    expect(isRemoteChainSupported(invalidGenesis)).toBe(false);
    expect(createRemoteChainProvider(invalidGenesis)).toBeNull();
  });

  it("handles disconnection cleanly and rejects subsequent sends on closed connection", async () => {
    // Given
    const dApp = createTestDApp();
    dApp.send(Rpc.request(1));
    await frame.bootAndConnect();

    // When
    dApp.connection.disconnect();
    await elapse(1);

    // Then: Disconnect request posted to frame
    const disconnectRequest = frame
      .requests()
      .find((r) => r.method === "chainDisconnect");
    expect(disconnectRequest).toBeDefined();
    frame.respond(disconnectRequest!.id, undefined);
    await elapse(1);

    // And When: Double disconnect on already-disconnected connection
    dApp.connection.disconnect();

    // And When: Sending on closed connection
    dApp.send(Rpc.request(15));
    expect(dApp.lastReply()).toMatchObject({
      jsonrpc: "2.0",
      id: 15,
      error: {
        code: -32603,
        message: "Chain connection is closed",
      },
    });
  });

  it("reports error when chainSend rejects on an active connection", async () => {
    // Given
    const dApp = createTestDApp();
    dApp.send(Rpc.request(1));
    await frame.bootAndConnect();

    // When: Send request after connection established
    dApp.send(Rpc.request(12, "chain_getBlock"));
    await elapse(1);

    const sendRequest = frame
      .requests()
      .filter((r) => r.method === "chainSend")
      .find((r) => {
        const payload = r.payload;
        if (
          payload &&
          typeof payload === "object" &&
          "message" in payload &&
          typeof payload.message === "string"
        ) {
          return payload.message.includes('"id":12');
        }
        return false;
      });
    expect(sendRequest).toBeDefined();

    // And When: Host frame rejects the send
    frame.respondError(sendRequest!.id, "Frame network buffer full");
    await elapse(1);

    // Then: dApp receives JSON-RPC error response
    expect(dApp.lastReply()).toMatchObject({
      jsonrpc: "2.0",
      id: 12,
      error: {
        code: -32603,
        message: "Frame network buffer full",
      },
    });
  });

  it("cleans up connection when receiving chain-halt envelope", async () => {
    // Given
    const dApp = createTestDApp();
    dApp.send(Rpc.request(1));
    await frame.bootAndConnect();

    // When: Frame halts the connection
    frame.chainHalt(frame.connectionId());
    await elapse(1);

    // Then: Subsequent sends are rejected immediately
    dApp.send(Rpc.request(22));
    expect(dApp.lastReply()).toMatchObject({
      jsonrpc: "2.0",
      id: 22,
      error: {
        message: "Chain connection is closed",
      },
    });
  });

  it("ignores notification-style requests with no id on closed connections", async () => {
    // Given
    const dApp = createTestDApp();
    dApp.send(Rpc.request(1));
    await frame.bootAndConnect();
    dApp.connection.disconnect();
    await elapse(1);

    // When: Notification request sent (no id)
    dApp.send({
      jsonrpc: "2.0",
      method: "chainHead_v1_unpin",
      params: ["token"],
    });

    // Then: Only the initial request's messages exist, no error reply emitted
    expect(dApp.replies()).toHaveLength(0);
  });

  it("rejects broadcasts from an untrusted window once the protocol frame is torn down", async () => {
    // Given: Frame is booted, a chain connection established, and a shared-auth listener subscribed
    const dApp = createTestDApp();
    dApp.send(Rpc.request(1));
    await frame.bootAndConnect();

    const forgedChanges: unknown[] = [];
    const unsubscribe = subscribeSharedAuthStorage((change) => {
      forgedChanges.push(change);
    });

    // When: The frame is torn down and an untrusted window posts a forged
    // broadcast with a valid origin
    const trustedOrigin = getProtocolOrigin();
    resetProtocolFrame();
    await elapse(10);

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: trustedOrigin,
        data: {
          namespace: "dotli:protocol",
          kind: "auth-storage-changed",
          siteId: SITE_ID,
          key: SHARED_CORE_SESSION_KEY,
          value: "attacker-injected-session",
        },
        source: window,
      }),
    );
    await elapse(10);

    // Then: The forged broadcast never reaches the subscriber
    unsubscribe();
    expect(forgedChanges).toEqual([]);
  });
});
