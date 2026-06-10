import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveServicesConfig } from "@dotli/config/network";
import { createChainConnect } from "@dotli/ui/host-callbacks/Chain";

const mocks = vi.hoisted(() => ({
  backend: "smoldot-shared-worker",
  smoldotProvider: vi.fn(),
  rpcProvider: vi.fn(),
  createSmoldotChainProvider: vi.fn(),
  createRpcChainProvider: vi.fn(),
  isSmoldotChainSupported: vi.fn(),
  isRpcChainSupported: vi.fn(),
}));

vi.mock("@dotli/config/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotli/config/config")>();
  return {
    ...actual,
    SS_USE_SMOLDOT: false,
  };
});

vi.mock("@dotli/config/mode", () => ({
  getBackend: () => mocks.backend,
}));

vi.mock("@dotli/resolver/chains", () => ({
  createChainProvider: mocks.createSmoldotChainProvider,
  isChainSupported: mocks.isSmoldotChainSupported,
}));

vi.mock("@dotli/resolver/rpc-chain", () => ({
  createRpcChainProvider: mocks.createRpcChainProvider,
  isRpcChainSupported: mocks.isRpcChainSupported,
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
    mocks.isSmoldotChainSupported.mockReturnValue(true);
    mocks.isRpcChainSupported.mockReturnValue(true);
  });

  it("routes People-chain statement-store connections through RPC by default", async () => {
    const peopleGenesis = getActiveServicesConfig().people.genesis;

    await createChainConnect()(hexBytes(peopleGenesis));

    expect(mocks.createRpcChainProvider).toHaveBeenCalledWith(peopleGenesis);
    expect(mocks.createSmoldotChainProvider).not.toHaveBeenCalled();
  });

  it("keeps non-People chain connections on the selected smoldot backend", async () => {
    const assetHubGenesis = getActiveServicesConfig().assethub.genesis;

    await createChainConnect()(hexBytes(assetHubGenesis));

    expect(mocks.createSmoldotChainProvider).toHaveBeenCalledWith(assetHubGenesis);
    expect(mocks.createRpcChainProvider).not.toHaveBeenCalled();
  });

  it("passes core pairing snapshot-query traffic through untouched", async () => {
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
      id: "truapi:sso-pairing:1:query:2",
      method: "statement_subscribeStatement",
      params: [{ matchAll: [] }],
    };
    connection.send(JSON.stringify(query));
    expect(sent).toEqual([query]);

    const ack = {
      jsonrpc: "2.0",
      id: "truapi:sso-pairing:1:query:2",
      result: "remote-sub",
    };
    onMessage?.(ack);
    const responses = connection.responses()[Symbol.asyncIterator]();
    expect(JSON.parse((await responses.next()).value)).toEqual(ack);
    await responses.return?.();
  });
});
