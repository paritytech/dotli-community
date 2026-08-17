// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  createChainConnectionClient,
  createPapiChainProvider,
  type ChainConnectionTransport,
} from "@dotli/protocol/chain-connection";
import { ChainConnectionError } from "@dotli/protocol/errors";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTransport(): {
  transport: ChainConnectionTransport;
  connect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  return {
    connect,
    send,
    disconnect,
    transport: { connect, send, disconnect },
  };
}

describe("chain connection client", () => {
  it("resolves only after the protocol acknowledges the connection", async () => {
    const acknowledgement = deferred<void>();
    const fixture = createTransport();
    fixture.connect.mockReturnValue(acknowledgement.promise);
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    let resolved = false;

    const pending = client.connectChain("0x1234").then((connection) => {
      resolved = true;
      return connection;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    acknowledgement.resolve(undefined);
    await pending;
    expect(resolved).toBe(true);
  });

  it("routes string responses to their logical connection", async () => {
    const fixture = createTransport();
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    const connection = await client.connectChain("0x1234");
    const responses = connection.responses()[Symbol.asyncIterator]();

    client.handleMessage("connection-1", '{"jsonrpc":"2.0","id":1}');

    await expect(responses.next()).resolves.toEqual({
      done: false,
      value: '{"jsonrpc":"2.0","id":1}',
    });
    await responses.return?.();
  });

  it("assigns a unique ID to each logical connection", async () => {
    const fixture = createTransport();
    const ids = ["connection-1", "connection-2"];
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => ids.shift() ?? "unexpected",
    });

    const first = await client.connectChain("0x1234");
    const second = await client.connectChain("0x1234");

    expect(fixture.connect.mock.calls).toEqual([
      ["0x1234", "connection-1"],
      ["0x1234", "connection-2"],
    ]);
    first.close();
    second.close();
  });

  it("terminates a waiting response iterator when the chain halts", async () => {
    const fixture = createTransport();
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    const connection = await client.connectChain("0x1234");
    const responses = connection.responses()[Symbol.asyncIterator]();
    const next = responses.next();

    client.handleHalt("connection-1", "smoldot stopped");

    await expect(next).rejects.toMatchObject({
      code: "CHAIN_HALTED",
      message: "smoldot stopped",
    });
  });

  it("removes failed setup state and preserves the typed failure", async () => {
    const fixture = createTransport();
    fixture.connect.mockRejectedValue(
      new ChainConnectionError("UNSUPPORTED_CHAIN", "Unsupported chain"),
    );
    const lateMessage = vi.fn();
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
      onLateMessage: lateMessage,
    });

    await expect(client.connectChain("0x1234")).rejects.toMatchObject({
      code: "UNSUPPORTED_CHAIN",
    });
    client.handleMessage("connection-1", "late");
    expect(lateMessage).toHaveBeenCalledWith("connection-1");
  });

  it("disconnects exactly once", async () => {
    const fixture = createTransport();
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    const connection = await client.connectChain("0x1234");

    connection.close();
    connection.close();

    await vi.waitFor(() => {
      expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects sends after close", async () => {
    const fixture = createTransport();
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    const connection = await client.connectChain("0x1234");

    connection.close();

    expect(() => connection.send("request")).toThrow(
      "Chain connection is closed",
    );
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("terminates every response iterator after a protocol failure", async () => {
    const fixture = createTransport();
    let nextId = 0;
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => `connection-${String(++nextId)}`,
    });
    const first = await client.connectChain("0x1234");
    const second = await client.connectChain("0x5678");
    const firstNext = first.responses()[Symbol.asyncIterator]().next();
    const secondNext = second.responses()[Symbol.asyncIterator]().next();

    client.failAll(
      new ChainConnectionError("PROTOCOL_UNAVAILABLE", "Protocol frame failed"),
    );

    await expect(firstNext).rejects.toMatchObject({
      code: "PROTOCOL_UNAVAILABLE",
    });
    await expect(secondNext).rejects.toMatchObject({
      code: "PROTOCOL_UNAVAILABLE",
    });
  });
});

describe("PAPI chain provider adapter", () => {
  it("buffers requests until connectChain resolves and preserves order", async () => {
    const acknowledgement = deferred<void>();
    const fixture = createTransport();
    fixture.connect.mockReturnValue(acknowledgement.promise);
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    const provider = createPapiChainProvider(() =>
      client.connectChain("0x1234"),
    );
    const connection = provider(vi.fn());
    const first = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "first",
      params: [],
    };
    const second = {
      jsonrpc: "2.0" as const,
      id: 2,
      method: "second",
      params: [],
    };

    connection.send(first);
    connection.send(second);
    expect(fixture.send).not.toHaveBeenCalled();
    acknowledgement.resolve(undefined);

    await vi.waitFor(() => {
      expect(fixture.send.mock.calls).toEqual([
        ["connection-1", JSON.stringify(first)],
        ["connection-1", JSON.stringify(second)],
      ]);
    });
    connection.disconnect();
  });

  it("converts string responses back to PAPI messages", async () => {
    const fixture = createTransport();
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    const onMessage = vi.fn();
    const provider = createPapiChainProvider(() =>
      client.connectChain("0x1234"),
    );
    const connection = provider(onMessage);

    await vi.waitFor(() => {
      expect(fixture.connect).toHaveBeenCalled();
    });
    client.handleMessage(
      "connection-1",
      '{"jsonrpc":"2.0","id":1,"result":"ok"}',
    );

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id: 1,
        result: "ok",
      });
    });
    connection.disconnect();
  });

  it("returns JSON-RPC errors for queued requests when setup fails", async () => {
    const connectError = new ChainConnectionError(
      "UNSUPPORTED_CHAIN",
      "Unsupported chain",
    );
    const onMessage = vi.fn();
    const provider = createPapiChainProvider(async () => {
      throw connectError;
    });
    const connection = provider(onMessage);

    connection.send({
      jsonrpc: "2.0",
      id: "request-1",
      method: "test",
      params: [],
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id: "request-1",
        error: { code: -32603, message: "Unsupported chain" },
      });
    });

    connection.send({
      jsonrpc: "2.0",
      id: "request-2",
      method: "test-again",
      params: [],
    });
    expect(onMessage).toHaveBeenLastCalledWith({
      jsonrpc: "2.0",
      id: "request-2",
      error: { code: -32603, message: "Unsupported chain" },
    });
  });

  it("does not fabricate an error response for a failed notification", async () => {
    const onMessage = vi.fn();
    const provider = createPapiChainProvider(async () => {
      throw new Error("Connection failed");
    });
    const connection = provider(onMessage);

    connection.send({
      jsonrpc: "2.0",
      method: "notify",
      params: [],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("closes an eventual connection after disconnect during setup", async () => {
    const acknowledgement = deferred<void>();
    const fixture = createTransport();
    fixture.connect.mockReturnValue(acknowledgement.promise);
    const client = createChainConnectionClient({
      transport: fixture.transport,
      createConnectionId: () => "connection-1",
    });
    const provider = createPapiChainProvider(() =>
      client.connectChain("0x1234"),
    );
    const connection = provider(vi.fn());

    connection.send({
      jsonrpc: "2.0",
      id: 1,
      method: "queued",
      params: [],
    });
    connection.disconnect();
    connection.disconnect();
    acknowledgement.resolve(undefined);

    await vi.waitFor(() => {
      expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
