import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { JsonRpcProvider } from "polkadot-api";
import { getActiveServicesConfig } from "@dotli/config/network";
import {
  createCoreRpcChainProvider,
  createRpcChainProvider,
  isCoreRpcChainSupported,
  isRpcChainSupported,
} from "@dotli/resolver/rpc-chain";

function parseRequest(message: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(message);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON-RPC request object");
  }
  return parsed as Record<string, unknown>;
}

class TestWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];
  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;
  answerHealth = true;

  constructor(url: string) {
    super();
    this.url = url;
    TestWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(message: string): void {
    if (this.readyState !== 1) {
      throw new Error("Socket is not open");
    }
    this.sent.push(message);
    const request = parseRequest(message);
    let result: unknown;
    if (request["method"] === "rpc_methods") {
      result = {
        methods: [
          "statement_subscribeStatement",
          "statement_unsubscribeStatement",
          "chain_getHeader",
          "system_health",
        ],
      };
    } else if (this.answerHealth && request["method"] === "system_health") {
      result = { peers: 1, isSyncing: false, shouldHavePeers: true };
    } else {
      return;
    }
    queueMicrotask(() => {
      if (this.readyState === 1) {
        this.receive({ jsonrpc: "2.0", id: request["id"], result });
      }
    });
  }

  receive(message: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  fail(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("error"));
  }
}

function latestSocket(): TestWebSocket {
  const socket = TestWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("Provider did not open a WebSocket");
  }
  return socket;
}

const disconnects: (() => void)[] = [];

function connect(
  provider: JsonRpcProvider | null,
  onMessage: (message: unknown) => void,
): ReturnType<JsonRpcProvider> {
  if (!provider) {
    throw new Error("Expected a supported gateway chain");
  }
  const connection = provider(onMessage);
  disconnects.push(() => {
    connection.disconnect();
  });
  return connection;
}

async function openGateway(): Promise<{
  connection: ReturnType<JsonRpcProvider>;
  socket: TestWebSocket;
  onHalt: Mock<() => void>;
  onMessage: Mock<(message: unknown) => void>;
}> {
  const onHalt = vi.fn<() => void>();
  const onMessage = vi.fn<(message: unknown) => void>();
  const connection = connect(
    createCoreRpcChainProvider(
      getActiveServicesConfig().people.genesis,
      onHalt,
    ),
    onMessage,
  );
  await vi.advanceTimersByTimeAsync(0);
  const socket = latestSocket();
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  return { connection, socket, onHalt, onMessage };
}

describe("rpc-chain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestWebSocket.instances = [];
    vi.stubGlobal("WebSocket", TestWebSocket);
  });

  afterEach(() => {
    for (const disconnect of disconnects.splice(0)) {
      disconnect();
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects unknown genesis hashes for both product and core callers", () => {
    expect(isRpcChainSupported("0xdeadbeef")).toBe(false);
    expect(isCoreRpcChainSupported("0xdeadbeef")).toBe(false);
    expect(createRpcChainProvider("0xdeadbeef", vi.fn())).toBeNull();
    expect(createCoreRpcChainProvider("0xdeadbeef", vi.fn())).toBeNull();
  });

  it("reserves Bulletin RPC access for the host-owned Rust core", () => {
    const { people, bulletin } = getActiveServicesConfig();
    expect(isRpcChainSupported(people.genesis)).toBe(true);
    expect(createRpcChainProvider(people.genesis, vi.fn())).not.toBeNull();
    expect(isRpcChainSupported(bulletin.genesis)).toBe(false);
    expect(createRpcChainProvider(bulletin.genesis, vi.fn())).toBeNull();
    expect(isCoreRpcChainSupported(bulletin.genesis)).toBe(true);
    expect(
      createCoreRpcChainProvider(bulletin.genesis, vi.fn()),
    ).not.toBeNull();
  });

  it("keeps a quiet subscription alive beyond the heartbeat without exposing health replies", async () => {
    const { connection, socket, onHalt, onMessage } = await openGateway();
    connection.send({
      jsonrpc: "2.0",
      id: "subscribe",
      method: "statement_subscribeStatement",
      params: [{ matchAll: [] }],
    });
    socket.receive({ jsonrpc: "2.0", id: "subscribe", result: "statements" });
    onMessage.mockClear();

    await vi.advanceTimersByTimeAsync(185_000);

    const requests = socket.sent.map(parseRequest);
    expect(requests.map((request) => request["method"])).toContain(
      "system_health",
    );
    expect(onHalt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
    expect(TestWebSocket.instances).toEqual([socket]);
    const notification = {
      jsonrpc: "2.0",
      method: "statement_statement",
      params: {
        subscription: "statements",
        result: { event: "newStatements", data: { statements: ["0x1234"] } },
      },
    };
    socket.receive(notification);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(notification);
  });

  it("halts once on established socket loss instead of reconnecting and replaying pending requests", async () => {
    const { connection, socket, onHalt } = await openGateway();
    connection.send({
      jsonrpc: "2.0",
      id: "pending",
      method: "chain_getHeader",
      params: [],
    });
    socket.close();
    socket.fail();
    expect(onHalt).toHaveBeenCalledTimes(1);
    const sent = [...socket.sent];

    await vi.advanceTimersByTimeAsync(300_000);

    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
    expect(socket.sent).toEqual(sent);
    expect(TestWebSocket.instances).toEqual([socket]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("halts and releases the socket when health probes receive no response", async () => {
    const { socket, onHalt } = await openGateway();
    socket.answerHealth = false;

    await vi.advanceTimersByTimeAsync(125_000);

    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
    expect(TestWebSocket.instances).toEqual([socket]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels keepalive and socket timers on consumer disconnect without reporting a halt", async () => {
    const { connection, socket, onHalt } = await openGateway();
    await vi.advanceTimersByTimeAsync(65_000);
    connection.disconnect();
    const sent = [...socket.sent];

    await vi.advanceTimersByTimeAsync(300_000);

    expect(socket.readyState).toBe(3);
    expect(socket.sent).toEqual(sent);
    expect(TestWebSocket.instances).toEqual([socket]);
    expect(onHalt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails over an initial endpoint failure and delivers a queued request on the next endpoint", async () => {
    const relay = getActiveServicesConfig().relay;
    const onHalt = vi.fn();
    const onMessage = vi.fn();
    const connection = connect(
      createCoreRpcChainProvider(relay.genesis, onHalt),
      onMessage,
    );
    const request = {
      jsonrpc: "2.0" as const,
      id: "queued",
      method: "chain_getHeader",
      params: [],
    };
    connection.send(request);
    await vi.advanceTimersByTimeAsync(0);
    const failed = latestSocket();
    failed.fail();

    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = latestSocket();
    expect(replacement).not.toBe(failed);
    expect(replacement.url).not.toBe(failed.url);
    replacement.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.sent.map(parseRequest)).toContainEqual(request);
    const response = {
      jsonrpc: "2.0",
      id: "queued",
      result: { number: "0x20" },
    };
    replacement.receive(response);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(response);
    expect(onHalt).not.toHaveBeenCalled();
  });
});
