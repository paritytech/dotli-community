import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostRequestLoginResponse,
  VersionedHostRequestLoginError,
  decodeWireMessage,
  encodeWireMessage,
  scale,
} from "@parity/truapi";
import { ACCOUNT_REQUEST_LOGIN } from "@parity/truapi/wire-table";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type MockProvider = {
  postMessage: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  subscribeClose: ReturnType<typeof vi.fn>;
  disconnectSession: ReturnType<typeof vi.fn>;
  getPermissionAuthorizationStatus: ReturnType<typeof vi.fn>;
  getPermissionAuthorizationStatuses: ReturnType<typeof vi.fn>;
  setPermissionAuthorizationStatus: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

type MockRuntime = {
  createProvider: ReturnType<typeof vi.fn>;
  cancelPairing: ReturnType<typeof vi.fn>;
  notifySessionStoreChanged: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

type ProviderListener = (message: Uint8Array) => void;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  coreProviders: [] as MockProvider[],
  coreProviderDefers: [] as Deferred<MockProvider>[],
  coreRuntimes: [] as MockRuntime[],
  iframeHosts: [] as {
    iframeUrl: string;
    iframe: HTMLIFrameElement;
    dispose: ReturnType<typeof vi.fn>;
  }[],
  createWebWorkerPairingHostRuntime: vi.fn(),
  createIframeHost: vi.fn(),
  createWasmRawCallbacks: vi.fn((callbacks: unknown) => callbacks),
  timerStop: vi.fn(),
  HostWorker: vi.fn(),
}));

vi.mock("@parity/truapi-host", () => ({
  createWasmRawCallbacks: mocks.createWasmRawCallbacks,
}));

vi.mock("@parity/truapi-host/web", () => ({
  createWebWorkerPairingHostRuntime: mocks.createWebWorkerPairingHostRuntime,
  createIframeHost: mocks.createIframeHost,
}));

vi.mock("@parity/truapi-host/worker-runtime?worker", () => ({
  default: mocks.HostWorker,
}));

vi.mock("@dotli/metrics/metrics", () => ({
  m: {
    measure: vi.fn(),
    timer: vi.fn(() => mocks.timerStop),
  },
}));

function makeProvider(): MockProvider {
  const provider = {
    postMessage: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeClose: vi.fn(() => () => {}),
    disconnectSession: vi.fn(async () => {}),
    getPermissionAuthorizationStatus: vi.fn(async () => "NotDetermined"),
    getPermissionAuthorizationStatuses: vi.fn(async (requests: unknown[]) =>
      requests.map(() => "NotDetermined"),
    ),
    setPermissionAuthorizationStatus: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  mocks.coreProviders.push(provider);
  return provider;
}

function makeLoginProvider(options: {
  onPostMessage?: (message: Uint8Array) => void;
}): MockProvider & { listener: ProviderListener | null } {
  const provider = {
    listener: null as ProviderListener | null,
    postMessage: vi.fn((message: Uint8Array) => {
      options.onPostMessage?.(message);
    }),
    subscribe: vi.fn((callback: ProviderListener) => {
      provider.listener = callback;
      return () => {
        provider.listener = null;
      };
    }),
    subscribeClose: vi.fn(() => () => {}),
    disconnectSession: vi.fn(async () => {}),
    getPermissionAuthorizationStatus: vi.fn(async () => "NotDetermined"),
    getPermissionAuthorizationStatuses: vi.fn(async (requests: unknown[]) =>
      requests.map(() => "NotDetermined"),
    ),
    setPermissionAuthorizationStatus: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return provider;
}

function makeRuntime(): MockRuntime {
  const runtime = {
    createProvider: vi.fn(() => {
      const item = deferred<MockProvider>();
      mocks.coreProviderDefers.push(item);
      return item.promise;
    }),
    cancelPairing: vi.fn(),
    notifySessionStoreChanged: vi.fn(),
    dispose: vi.fn(),
  };
  mocks.coreRuntimes.push(runtime);
  return runtime;
}

function loginResponseFrame(
  requestId: string,
  result:
    | { success: true; value: "Success" | "AlreadyConnected" | "Rejected" }
    | { success: false; reason: string }
    | { success: false; hostFailure: string },
): Uint8Array {
  const responseCodec = scale.indexedTaggedUnion({
    V1: [
      0,
      scale.Result(
        HostRequestLoginResponse,
        scale.CallError(VersionedHostRequestLoginError),
      ),
    ] as const,
  });
  const value = responseCodec.enc({
    tag: "V1",
    value: result.success
      ? { success: true, value: result.value }
      : "hostFailure" in result
        ? {
            success: false,
            value: {
              tag: "HostFailure",
              value: { reason: result.hostFailure },
            },
          }
        : {
            success: false,
            value: {
              tag: "Domain",
              value: {
                tag: "V1",
                value: {
                  tag: "Unknown",
                  value: { reason: result.reason },
                },
              },
            },
          },
  });
  const frame = encodeWireMessage({
    requestId,
    payload: {
      id: ACCOUNT_REQUEST_LOGIN.response,
      value,
    },
  });
  if (frame.isErr()) {
    throw frame.error;
  }
  return frame.value;
}

function requestIdFromFrame(message: Uint8Array): string {
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    throw decoded.error;
  }
  return decoded.value.requestId;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForProviderRequests(count: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (mocks.coreProviderDefers.length >= count) {
      return;
    }
    await flushMicrotasks();
  }
  throw new Error(`expected ${count} provider request(s)`);
}

async function waitForMockCalls(
  mock: ReturnType<typeof vi.fn>,
  count: number,
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (mock.mock.calls.length >= count) {
      return;
    }
    await flushMicrotasks();
  }
  throw new Error(`expected ${count} mock call(s)`);
}

describe("bridge render lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.coreProviders.length = 0;
    mocks.coreProviderDefers.length = 0;
    mocks.coreRuntimes.length = 0;
    mocks.iframeHosts.length = 0;
    document.body.innerHTML = `<div id="app"></div>`;
    mocks.createWebWorkerPairingHostRuntime.mockImplementation(() =>
      Promise.resolve(makeRuntime()),
    );
    mocks.createIframeHost.mockImplementation(
      (args: { iframeUrl: string; container: HTMLElement }) => {
        const iframe = document.createElement("iframe");
        iframe.dataset.src = args.iframeUrl;
        args.container.appendChild(iframe);
        const dispose = vi.fn(() => {
          iframe.remove();
        });
        const host = { iframeUrl: args.iframeUrl, iframe, dispose };
        mocks.iframeHosts.push(host);
        return { iframe, dispose };
      },
    );
  });

  it("disposes a host that resolves after a newer render has started", async () => {
    const { renderIframe } = await import("@dotli/ui/bridge");

    const first = renderIframe("https://first.example/app", "first");
    await waitForProviderRequests(1);
    const second = renderIframe("https://second.example/app", "second");
    await waitForProviderRequests(2);

    const secondProvider = makeProvider();
    mocks.coreProviderDefers[1].resolve(secondProvider);
    await second;
    expect(document.querySelector("iframe")?.dataset.src).toBe(
      "https://second.example/app",
    );

    const firstProvider = makeProvider();
    mocks.coreProviderDefers[0].resolve(firstProvider);
    await first;

    expect(mocks.iframeHosts).toHaveLength(2);
    const firstHost = mocks.iframeHosts.find(
      (host) => host.iframeUrl === "https://first.example/app",
    );
    expect(firstHost?.dispose).toHaveBeenCalledTimes(1);
    expect(firstProvider.dispose).toHaveBeenCalledTimes(1);
    expect(secondProvider.dispose).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")?.dataset.src).toBe(
      "https://second.example/app",
    );
  });

  it("boots the landing auth core to disconnect a stored session without a product", async () => {
    await import("@dotli/ui/bridge");

    window.dispatchEvent(new Event("dotli:truapi-disconnect-request"));
    await waitForProviderRequests(1);

    const provider = makeProvider();
    mocks.coreProviderDefers[0].resolve(provider);
    await waitForMockCalls(provider.disconnectSession, 1);

    expect(provider.disconnectSession).toHaveBeenCalledTimes(1);
  });
});

describe("requestCoreLogin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="app"></div>`;
  });

  it("resolves successful login responses", async () => {
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const provider = makeLoginProvider({
      onPostMessage(message) {
        provider.listener?.(
          loginResponseFrame(requestIdFromFrame(message), {
            success: true,
            value: "Success",
          }),
        );
      },
    });

    await expect(requestCoreLogin(provider)).resolves.toBe("Success");
    expect(provider.subscribe).toHaveBeenCalledTimes(1);
    expect(provider.listener).toBeNull();
  });

  it("rejects typed login errors as LoginRequestError", async () => {
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const provider = makeLoginProvider({
      onPostMessage(message) {
        provider.listener?.(
          loginResponseFrame(requestIdFromFrame(message), {
            success: false,
            reason: "Rejected",
          }),
        );
      },
    });

    const promise = requestCoreLogin(provider);

    await expect(promise).rejects.toThrow("Rejected");
    await expect(promise).rejects.toMatchObject({
      name: "LoginRequestError",
      error: {
        tag: "Domain",
        value: {
          tag: "V1",
          value: { tag: "Unknown", value: { reason: "Rejected" } },
        },
      },
    });
    expect(provider.listener).toBeNull();
  });

  it("rejects host failures with the reason as the error message", async () => {
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const reason = "no free statement-store slot for device registration";
    const provider = makeLoginProvider({
      onPostMessage(message) {
        provider.listener?.(
          loginResponseFrame(requestIdFromFrame(message), {
            success: false,
            hostFailure: reason,
          }),
        );
      },
    });

    const promise = requestCoreLogin(provider);

    await expect(promise).rejects.toThrow(reason);
    await expect(promise).rejects.toMatchObject({
      name: "LoginRequestError",
      error: { tag: "HostFailure", value: { reason } },
    });
    expect(provider.listener).toBeNull();
  });

  it("rejects malformed response frames and unsubscribes", async () => {
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const provider = makeLoginProvider({
      onPostMessage() {
        provider.listener?.(new Uint8Array([0xff, 0x00]));
      },
    });

    await expect(requestCoreLogin(provider)).rejects.toThrow();
    expect(provider.listener).toBeNull();
  });

  it("rejects send failures and unsubscribes", async () => {
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const provider = makeLoginProvider({
      onPostMessage() {
        throw new Error("send failed");
      },
    });

    await expect(requestCoreLogin(provider)).rejects.toThrow("send failed");
    expect(provider.listener).toBeNull();
  });
});
