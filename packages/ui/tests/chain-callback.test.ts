import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformJsonRpcConnection } from "@parity/truapi-host";
import { getActiveServicesConfig } from "@dotli/config/network";
import { createChainConnect } from "@dotli/ui/host-callbacks/Chain";

const mocks = vi.hoisted(() => {
  const smoldotBrokerProvider = vi.fn();
  return {
    backend: "smoldot-shared-worker",
    smoldotProvider: vi.fn(),
    rpcProvider: vi.fn(),
    smoldotBrokerProvider,
    createSmoldotChainProvider: vi.fn(),
    createRpcChainProvider: vi.fn(),
    isSmoldotChainSupported: vi.fn(),
    isCoreRpcChainSupported: vi.fn(),
    createChainBrokerManager: vi.fn(() => ({
      connectRemote: vi.fn(),
      getLocalProvider: smoldotBrokerProvider,
      disconnectAll: vi.fn(),
    })),
  };
});

vi.mock("@dotli/config/mode", () => ({
  getBackend: () => mocks.backend,
}));

vi.mock("@dotli/resolver/provider", () => ({
  createChainProvider: mocks.createSmoldotChainProvider,
  isChainSupported: mocks.isSmoldotChainSupported,
}));

vi.mock("@dotli/resolver/rpc-chain", () => ({
  createCoreRpcChainProvider: mocks.createRpcChainProvider,
  isCoreRpcChainSupported: mocks.isCoreRpcChainSupported,
}));

vi.mock("@dotli/protocol/broker", () => ({
  createChainBrokerManager: mocks.createChainBrokerManager,
}));

function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function openRpcConnection(): Promise<{
  connection: PlatformJsonRpcConnection;
  disconnect: ReturnType<typeof vi.fn>;
  halt: () => void;
  receive: (message: unknown) => void;
}> {
  mocks.backend = "rpc-gateway";
  let halt: () => void = () => {
    throw new Error("Gateway halt callback was not registered");
  };
  let receive: (message: unknown) => void = () => {
    throw new Error("Gateway response callback was not registered");
  };
  const disconnect = vi.fn();
  mocks.createRpcChainProvider.mockImplementation(
    (_genesis: string, onHalt: () => void) => {
      halt = onHalt;
      return mocks.rpcProvider;
    },
  );
  mocks.rpcProvider.mockImplementation(
    (onMessage: (message: unknown) => void) => {
      receive = onMessage;
      return { send: vi.fn(), disconnect };
    },
  );
  const connection = await createChainConnect()(
    hexBytes(getActiveServicesConfig().people.genesis),
  );
  return {
    connection,
    disconnect,
    halt: () => {
      halt();
    },
    receive: (message: unknown) => {
      receive(message);
    },
  };
}

describe("createChainConnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backend = "smoldot-shared-worker";
    mocks.smoldotProvider.mockReturnValue({
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    mocks.rpcProvider.mockReturnValue({
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    mocks.createSmoldotChainProvider.mockReturnValue(mocks.smoldotProvider);
    mocks.createRpcChainProvider.mockReturnValue(mocks.rpcProvider);
    mocks.smoldotBrokerProvider.mockReturnValue(mocks.smoldotProvider);
    mocks.isSmoldotChainSupported.mockReturnValue(true);
    mocks.isCoreRpcChainSupported.mockReturnValue(true);
  });

  it("As a dotli integrator, the host routes People-chain connections through the selected smoldot backend", async () => {
    // Given
    const peopleGenesis = getActiveServicesConfig().people.genesis;

    // When
    const connection = await createChainConnect()(hexBytes(peopleGenesis));

    // Then
    expect(mocks.smoldotBrokerProvider).toHaveBeenCalledWith(peopleGenesis);
    expect(mocks.createRpcChainProvider).not.toHaveBeenCalled();
    connection.close();
  });

  it("As a dotli integrator, the host keeps non-People chain connections on the selected smoldot backend", async () => {
    // Given
    const assetHubGenesis = getActiveServicesConfig().assethub.genesis;

    // When
    const connection = await createChainConnect()(hexBytes(assetHubGenesis));

    // Then
    expect(mocks.smoldotBrokerProvider).toHaveBeenCalledWith(assetHubGenesis);
    expect(mocks.createRpcChainProvider).not.toHaveBeenCalled();

    connection.close();
  });

  it("rejects unsupported chains without falling back from the selected RPC backend", () => {
    mocks.backend = "rpc-gateway";
    mocks.isCoreRpcChainSupported.mockReturnValue(false);

    expect(() => createChainConnect()(hexBytes("0xdeadbeef"))).toThrow(
      /Unsupported RPC chain/,
    );
    expect(mocks.createRpcChainProvider).not.toHaveBeenCalled();
    expect(mocks.smoldotBrokerProvider).not.toHaveBeenCalled();
  });

  it("rejects unsupported chains without falling back from the selected smoldot backend", () => {
    mocks.isSmoldotChainSupported.mockReturnValue(false);

    expect(() => createChainConnect()(hexBytes("0xdeadbeef"))).toThrow(
      /Unsupported smoldot chain/,
    );
    expect(mocks.smoldotBrokerProvider).not.toHaveBeenCalled();
    expect(mocks.createRpcChainProvider).not.toHaveBeenCalled();
  });

  it("ends a pending response read when the gateway halts", async () => {
    const { connection, halt, disconnect } = await openRpcConnection();
    const responses = connection.responses()[Symbol.asyncIterator]();
    const pending = responses.next();

    halt();

    expect(await pending).toEqual({ done: true, value: undefined });
    expect(disconnect).toHaveBeenCalledTimes(1);
    halt();
    connection.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("ends a pending response read when the consumer closes the connection", async () => {
    const { connection, disconnect } = await openRpcConnection();
    const responses = connection.responses()[Symbol.asyncIterator]();
    const pending = responses.next();

    connection.close();

    expect(await pending).toEqual({ done: true, value: undefined });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not wait again when closed while the response iterator is suspended after yielding", async () => {
    const { connection, receive, disconnect } = await openRpcConnection();
    const responses = connection.responses()[Symbol.asyncIterator]();
    const pending = responses.next();
    const response = { jsonrpc: "2.0", id: "subscribe", result: "statements" };
    receive(response);
    await pending;

    connection.close();
    receive({ jsonrpc: "2.0", id: "late", result: null });

    expect(await responses.next()).toEqual({ done: true, value: undefined });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects sends after an explicit close", async () => {
    const { connection } = await openRpcConnection();
    connection.close();

    expect(() => {
      connection.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "late",
          method: "chain_getHeader",
          params: [],
        }),
      );
    }).toThrow();
  });

  it("rejects sends after the gateway halts", async () => {
    const { connection, halt } = await openRpcConnection();
    halt();

    expect(() => {
      connection.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "late",
          method: "chain_getHeader",
          params: [],
        }),
      );
    }).toThrow();
  });
});
