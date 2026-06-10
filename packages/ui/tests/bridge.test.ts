import { beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type MockProvider = {
  postMessage: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  subscribeClose: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

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
  iframeHosts: [] as {
    iframeUrl: string;
    iframe: HTMLIFrameElement;
    dispose: ReturnType<typeof vi.fn>;
  }[],
  createWebWorkerProvider: vi.fn(),
  createIframeHost: vi.fn(),
  createWasmRawCallbacks: vi.fn((callbacks: unknown) => callbacks),
  timerStop: vi.fn(),
  HostWorker: vi.fn(),
}));

vi.mock("@parity/truapi-host-wasm", () => ({
  createWasmRawCallbacks: mocks.createWasmRawCallbacks,
}));

vi.mock("@parity/truapi-host-wasm/web", () => ({
  createWebWorkerProvider: mocks.createWebWorkerProvider,
  createIframeHost: mocks.createIframeHost,
}));

vi.mock("@parity/truapi-host-wasm/worker-runtime?worker", () => ({
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
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  mocks.coreProviders.push(provider);
  return provider;
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

describe("bridge render lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.coreProviders.length = 0;
    mocks.coreProviderDefers.length = 0;
    mocks.iframeHosts.length = 0;
    document.body.innerHTML = `<div id="app"></div>`;
    mocks.createWebWorkerProvider.mockImplementation(() => {
      const item = deferred<MockProvider>();
      mocks.coreProviderDefers.push(item);
      return item.promise;
    });
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
});
