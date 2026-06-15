// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";
import { createChainBrokerManager } from "@dotli/protocol/broker";

function createProviderHarness(): {
  provider: JsonRpcProvider;
  sent: JsonRpcRequest[];
  disconnect: ReturnType<typeof vi.fn>;
  emit: (message: JsonRpcMessage) => void;
} {
  const sent: JsonRpcRequest[] = [];
  const disconnect = vi.fn();
  let onMessage: ((message: JsonRpcMessage) => void) | null = null;

  const provider: JsonRpcProvider = (listener): JsonRpcConnection => {
    onMessage = listener;
    return {
      send(message) {
        sent.push(message);
      },
      disconnect,
    };
  };

  return {
    provider,
    sent,
    disconnect,
    emit(message) {
      onMessage?.(message);
    },
  };
}

describe("createChainBrokerManager", () => {
  it("remaps request ids and routes responses back to the correct client", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager((genesisHash) =>
      genesisHash === "asset-hub" ? harness.provider : null,
    );

    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote(
      "asset-hub",
      "conn-a",
      (message) => {
        messagesA.push(message);
      },
    );
    const connectionB = manager.connectRemote(
      "asset-hub",
      "conn-b",
      (message) => {
        messagesB.push(message);
      },
    );

    expect(connectionA).not.toBeNull();
    expect(connectionB).not.toBeNull();

    connectionA?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chainHead_v1_header",
        params: ["token-a", "0xabc"],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "chainHead_v1_header",
        params: ["token-b", "0xdef"],
      }),
    );

    const upstreamA = harness.sent[0] as { id: string };
    const upstreamB = harness.sent[1] as { id: string };

    harness.emit({ jsonrpc: "2.0", id: upstreamB.id, result: "header-b" });
    harness.emit({ jsonrpc: "2.0", id: upstreamA.id, result: "header-a" });

    expect(messagesA).toEqual([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "header-a" }),
    ]);
    expect(messagesB).toEqual([
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: "header-b" }),
    ]);
  });

  it("rewrites subscription tokens per client and routes follow events", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote(
      "asset-hub",
      "conn-a",
      (message) => {
        messagesA.push(message);
      },
    );
    const connectionB = manager.connectRemote(
      "asset-hub",
      "conn-b",
      (message) => {
        messagesB.push(message);
      },
    );

    connectionA?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );

    expect(harness.sent).toHaveLength(1);
    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: "2.0", id: upstream.id, result: "up-a" });

    const localTokenA = (JSON.parse(messagesA[0] ?? "{}") as { result: string })
      .result;
    const localTokenB = (JSON.parse(messagesB[0] ?? "{}") as { result: string })
      .result;
    expect(localTokenA).not.toBe(localTokenB);

    harness.emit({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: { subscription: "up-a", result: { event: "bestBlockChanged" } },
    });

    expect(messagesA[1]).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localTokenA,
          result: { event: "bestBlockChanged" },
        },
      }),
    );
    expect(messagesB[1]).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localTokenB,
          result: { event: "bestBlockChanged" },
        },
      }),
    );
  });

  it("releases owned subscriptions on disconnect but keeps the upstream warm until disconnectAll", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const connection = manager.connectRemote("asset-hub", "conn-a", () => {});

    connection?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );

    const upstreamRequest = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: "2.0", id: upstreamRequest.id, result: "up-a" });

    connection?.disconnect();

    const release = harness.sent[1] as { method: string; params: string[] };
    expect(release.method).toBe("chainHead_v1_unfollow");
    expect(release.params[0]).toBe("up-a");
    expect(harness.disconnect).not.toHaveBeenCalled();

    manager.disconnectAll();
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it("reuses the warm upstream when a new session attaches after every previous one disconnected", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);

    const connectionA = manager.connectRemote("asset-hub", "conn-a", () => {});
    connectionA?.disconnect();
    expect(harness.disconnect).not.toHaveBeenCalled();

    const connectionB = manager.connectRemote("asset-hub", "conn-b", () => {});
    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chainSpec_v1_chainName",
        params: [],
      }),
    );
    expect(harness.sent.at(-1)).toMatchObject({
      method: "chainSpec_v1_chainName",
    });
    expect(harness.disconnect).not.toHaveBeenCalled();

    manager.disconnectAll();
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it("replays a coherent cached follow snapshot to later subscribers", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote(
      "asset-hub",
      "conn-a",
      (message) => {
        messagesA.push(message);
      },
    );
    const connectionB = manager.connectRemote(
      "asset-hub",
      "conn-b",
      (message) => {
        messagesB.push(message);
      },
    );

    connectionA?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );

    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: "2.0", id: upstream.id, result: "up-a" });
    harness.emit({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: {
        subscription: "up-a",
        result: {
          event: "initialized",
          finalizedBlockHashes: ["0xfinal"],
          finalizedBlockRuntime: { type: "valid" },
        },
      },
    });
    harness.emit({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: {
        subscription: "up-a",
        result: {
          event: "newBlock",
          blockHash: "0xblock-1",
          parentBlockHash: "0xfinal",
        },
      },
    });
    harness.emit({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: {
        subscription: "up-a",
        result: {
          event: "newBlock",
          blockHash: "0xblock-2",
          parentBlockHash: "0xblock-1",
        },
      },
    });
    harness.emit({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: {
        subscription: "up-a",
        result: {
          event: "bestBlockChanged",
          bestBlockHash: "0xblock-2",
        },
      },
    });

    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );

    const localTokenB = (JSON.parse(messagesB[0] ?? "{}") as { result: string })
      .result;
    expect(messagesB.slice(1)).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localTokenB,
          result: {
            event: "initialized",
            finalizedBlockHashes: ["0xfinal"],
            finalizedBlockRuntime: { type: "valid" },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localTokenB,
          result: {
            event: "newBlock",
            blockHash: "0xblock-1",
            parentBlockHash: "0xfinal",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localTokenB,
          result: {
            event: "newBlock",
            blockHash: "0xblock-2",
            parentBlockHash: "0xblock-1",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localTokenB,
          result: {
            event: "bestBlockChanged",
            bestBlockHash: "0xblock-2",
          },
        },
      }),
    ]);
  });

  it("provides a local provider that uses the same upstream broker", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const localProvider = manager.getLocalProvider("asset-hub");
    const remoteMessages: string[] = [];

    expect(localProvider).not.toBeNull();

    // `getLocalProvider` uses the object wire. `connectRemote` uses the string wire.
    const localMessages: JsonRpcMessage[] = [];
    const localConnection = localProvider?.((message) => {
      localMessages.push(message);
    });
    const remoteConnection = manager.connectRemote(
      "asset-hub",
      "conn-a",
      (message) => {
        remoteMessages.push(message);
      },
    );

    localConnection?.send({
      jsonrpc: "2.0",
      id: "local-1",
      method: "chainHead_v1_header",
      params: ["token", "0xabc"],
    });
    remoteConnection?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "remote-1",
        method: "chainHead_v1_header",
        params: ["token", "0xdef"],
      }),
    );

    const localUpstream = harness.sent[0] as { id: string };
    const remoteUpstream = harness.sent[1] as { id: string };

    harness.emit({
      jsonrpc: "2.0",
      id: localUpstream.id,
      result: "local-result",
    });
    harness.emit({
      jsonrpc: "2.0",
      id: remoteUpstream.id,
      result: "remote-result",
    });

    expect(localMessages).toEqual([
      { jsonrpc: "2.0", id: "local-1", result: "local-result" },
    ]);
    expect(remoteMessages).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "remote-1",
        result: "remote-result",
      }),
    ]);
  });

  it("forwards exactly one upstream unpin when two sessions unpin the same shared block", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote(
      "asset-hub",
      "conn-a",
      (message) => {
        messagesA.push(message);
      },
    );
    const connectionB = manager.connectRemote(
      "asset-hub",
      "conn-b",
      (message) => {
        messagesB.push(message);
      },
    );

    // Both tabs follow with identical params -> coalesced to ONE upstream follow.
    connectionA?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );

    expect(harness.sent).toHaveLength(1);
    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: "2.0", id: upstream.id, result: "up-a" });

    const localTokenA = (JSON.parse(messagesA[0] ?? "{}") as { result: string })
      .result;
    const localTokenB = (JSON.parse(messagesB[0] ?? "{}") as { result: string })
      .result;
    expect(localTokenA).not.toBe(localTokenB);

    // The upstream reports a block; it fans out to both sessions, so both now
    // hold a pin on it.
    harness.emit({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: {
        subscription: "up-a",
        result: { event: "newBlock", blockHash: "0xblock" },
      },
    });

    // First tab unpins: still held by the second tab, so nothing forwarded.
    connectionA?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "chainHead_v1_unpin",
        params: [localTokenA, "0xblock"],
      }),
    );
    expect(
      harness.sent.filter(
        (message) =>
          (message as JsonRpcRequest).method === "chainHead_v1_unpin",
      ),
    ).toHaveLength(0);
    // ...but the tab still gets a success response immediately.
    expect(JSON.parse(messagesA.at(-1) ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: null,
    });

    // Second (last) tab unpins: now no session holds the block -> forward once.
    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "chainHead_v1_unpin",
        params: [localTokenB, "0xblock"],
      }),
    );

    const unpins = harness.sent.filter(
      (message) => (message as JsonRpcRequest).method === "chainHead_v1_unpin",
    );
    expect(unpins).toHaveLength(1);
    expect((unpins[0]?.params as unknown[])[0]).toBe("up-a");
    expect((unpins[0]?.params as unknown[])[1]).toBe("0xblock");
    expect(JSON.parse(messagesB.at(-1) ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 11,
      result: null,
    });
  });

  it("unpins a block upstream when its last holder disconnects (other sessions remain)", () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote("asset-hub", "conn-a", (m) =>
      messagesA.push(m),
    );
    const connectionB = manager.connectRemote("asset-hub", "conn-b", (m) =>
      messagesB.push(m),
    );

    connectionA?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "chainHead_v1_follow",
        params: [true],
      }),
    );
    harness.emit({
      jsonrpc: "2.0",
      id: (harness.sent[0] as { id: string }).id,
      result: "up-a",
    });
    const localTokenB = (JSON.parse(messagesB[0] ?? "{}") as { result: string })
      .result;

    // Both sessions hold the block.
    harness.emit({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: {
        subscription: "up-a",
        result: { event: "newBlock", blockHash: "0xblock" },
      },
    });

    // Session B unpins via its own token; A is still a holder -> no forward.
    connectionB?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "chainHead_v1_unpin",
        params: [localTokenB, "0xblock"],
      }),
    );
    expect(
      harness.sent.filter(
        (m) => (m as JsonRpcRequest).method === "chainHead_v1_unpin",
      ),
    ).toHaveLength(0);

    // A is now the sole holder. A disconnects while B is still following, so
    // the block is orphaned and the broker unpins it upstream exactly once.
    connectionA?.disconnect();

    const unpins = harness.sent.filter(
      (m) => (m as JsonRpcRequest).method === "chainHead_v1_unpin",
    );
    expect(unpins).toHaveLength(1);
    expect((unpins[0]?.params as unknown[])[0]).toBe("up-a");
    expect((unpins[0]?.params as unknown[])[1]).toBe("0xblock");
  });
});
