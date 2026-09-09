import { beforeEach, describe, expect, it, vi } from "vitest";
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
    await createChainConnect()(hexBytes(peopleGenesis));

    // Then
    expect(mocks.smoldotBrokerProvider).toHaveBeenCalledWith(peopleGenesis);
    expect(mocks.createRpcChainProvider).not.toHaveBeenCalled();
  });

  it("As a dotli integrator, the host keeps non-People chain connections on the selected smoldot backend", async () => {
    // Given
    const assetHubGenesis = getActiveServicesConfig().assethub.genesis;

    // When
    await createChainConnect()(hexBytes(assetHubGenesis));

    // Then
    expect(mocks.smoldotBrokerProvider).toHaveBeenCalledWith(assetHubGenesis);
    expect(mocks.createRpcChainProvider).not.toHaveBeenCalled();
  });

  it("As a dotli integrator, the host adapts brokered statement-store traffic to a platform connection", async () => {
    // Given
    let onMessage: ((message: unknown) => void) | undefined;
    const sent: unknown[] = [];
    mocks.smoldotProvider.mockImplementation(
      (handler: (message: unknown) => void) => {
        onMessage = handler;
        return {
          send: (request: unknown) => {
            sent.push(request);
          },
          disconnect: vi.fn(),
        };
      },
    );
    const assetHubGenesis = getActiveServicesConfig().assethub.genesis;

    const connection = await createChainConnect()(hexBytes(assetHubGenesis));
    const query = {
      jsonrpc: "2.0",
      id: "opaque-query-request",
      method: "statement_subscribeStatement",
      params: [{ matchAll: [] }],
    };

    // When
    connection.send(JSON.stringify(query));

    // Then
    expect(sent).toEqual([query]);

    // When
    const ack = {
      jsonrpc: "2.0",
      id: "opaque-query-request",
      result: "remote-sub",
    };
    onMessage?.(ack);

    // Then
    const responses = connection.responses()[Symbol.asyncIterator]();
    expect(JSON.parse((await responses.next()).value)).toEqual(ack);
    await responses.return?.();
  });

  it("As a dotli integrator, the host does not rewrite core chain RPC requests", async () => {
    // Given
    const sent: unknown[] = [];
    mocks.smoldotProvider.mockImplementation(
      (_handler: (message: unknown) => void) => ({
        send: (request: unknown) => {
          sent.push(request);
        },
        disconnect: vi.fn(),
      }),
    );
    const assetHubGenesis = getActiveServicesConfig().assethub.genesis;
    const connection = await createChainConnect()(hexBytes(assetHubGenesis));
    const unpin = {
      jsonrpc: "2.0",
      id: "core-unpin",
      method: "chainHead_v1_unpin",
      params: ["REMOTE-FOLLOW", "0xabc"],
    };

    // When
    connection.send(JSON.stringify(unpin));

    // Then
    expect(sent).toEqual([unpin]);
    connection.close();
  });
});
