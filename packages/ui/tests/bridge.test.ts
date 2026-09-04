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
type ProviderCloseListener = (error: Error) => void;

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
    allowedOrigin: string;
    allow: string;
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
}): MockProvider & {
  listener: ProviderListener | null;
  closeListener: ProviderCloseListener | null;
} {
  const provider = {
    listener: null as ProviderListener | null,
    closeListener: null as ProviderCloseListener | null,
    postMessage: vi.fn((message: Uint8Array) => {
      options.onPostMessage?.(message);
    }),
    subscribe: vi.fn((callback: ProviderListener) => {
      provider.listener = callback;
      return () => {
        provider.listener = null;
      };
    }),
    subscribeClose: vi.fn((callback: ProviderCloseListener) => {
      provider.closeListener = callback;
      return () => {
        provider.closeListener = null;
      };
    }),
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

async function waitForProviderRequests(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.coreProviderDefers.length).toBeGreaterThanOrEqual(count);
  });
}

async function waitForMockCalls(
  mock: ReturnType<typeof vi.fn>,
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(mock).toHaveBeenCalledTimes(count);
  });
}

describe("bridge render lifecycle", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.coreProviders.length = 0;
    mocks.coreProviderDefers.length = 0;
    mocks.coreRuntimes.length = 0;
    mocks.iframeHosts.length = 0;
    document.body.innerHTML = `<div id="app"></div>`;
    window.history.replaceState(null, "", "/");
    mocks.createWebWorkerPairingHostRuntime.mockImplementation(() =>
      Promise.resolve(makeRuntime()),
    );
    mocks.createIframeHost.mockImplementation(
      (args: {
        iframeUrl: string;
        allowedOrigin: string;
        allow: string;
        container: HTMLElement;
      }) => {
        const iframe = document.createElement("iframe");
        iframe.dataset.src = args.iframeUrl;
        args.container.appendChild(iframe);
        const dispose = vi.fn(() => {
          iframe.remove();
        });
        const host = {
          iframeUrl: args.iframeUrl,
          allowedOrigin: args.allowedOrigin,
          allow: args.allow,
          iframe,
          dispose,
        };
        mocks.iframeHosts.push(host);
        return { iframe, dispose };
      },
    );
    const [{ initBridgeEventListeners }, { createBlockingModalCoordinator }] =
      await Promise.all([
        import("@dotli/ui/bridge"),
        import("@dotli/ui/blocking-modal-queue"),
      ]);
    initBridgeEventListeners(createBlockingModalCoordinator());
  });

  it("As a dotli integrator, the host disposes a host that resolves after a newer render has started", async () => {
    // Given
    const { renderIframe } = await import("@dotli/ui/bridge");

    // When
    const first = renderIframe("https://first.example/app", "first");
    await waitForProviderRequests(1);
    const second = renderIframe("https://second.example/app", "second");
    await waitForProviderRequests(2);

    const secondProvider = makeProvider();
    mocks.coreProviderDefers[1].resolve(secondProvider);
    await second;

    // Then
    expect(document.querySelector("iframe")?.dataset.src).toBe(
      "https://second.example/app",
    );

    // When
    const firstProvider = makeProvider();
    mocks.coreProviderDefers[0].resolve(firstProvider);
    await first;

    // Then
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
  }, 10_000);

  it("As a dotli integrator, the host keeps the previous iframe visible while its replacement initializes", async () => {
    // Given
    const { renderIframe } = await import("@dotli/ui/bridge");

    const first = renderIframe("https://first.example/app", "first");
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await first;

    const firstHost = mocks.iframeHosts[0];
    const second = renderIframe("https://second.example/app", "second");
    await waitForProviderRequests(2);

    // Then
    expect(firstHost.iframe.isConnected).toBe(true);
    expect(firstHost.dispose).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")?.dataset.src).toBe(
      "https://first.example/app",
    );

    // When
    mocks.coreProviderDefers[1].resolve(makeProvider());
    await second;

    // Then
    expect(firstHost.dispose).toHaveBeenCalledTimes(1);
    const app = document.getElementById("app");
    expect(app?.querySelectorAll("iframe")).toHaveLength(1);
    expect(app?.querySelector("iframe")?.dataset.src).toBe(
      "https://second.example/app",
    );
  }, 10_000);

  it("As a dotli integrator, the host keeps the previous app-subdomain iframe visible while its replacement initializes", async () => {
    // Given
    const { renderAppSubdomain } = await import("@dotli/ui/bridge");

    const first = renderAppSubdomain("first-cid", "first");
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await first;

    const firstHost = mocks.iframeHosts[0];
    const second = renderAppSubdomain("second-cid", "first");
    await waitForProviderRequests(2);

    // Then
    expect(firstHost.iframe.isConnected).toBe(true);
    expect(firstHost.dispose).not.toHaveBeenCalled();

    // When
    mocks.coreProviderDefers[1].resolve(makeProvider());
    await second;

    // Then
    expect(firstHost.dispose).toHaveBeenCalledTimes(1);
    const app = document.getElementById("app");
    expect(app?.querySelectorAll("iframe")).toHaveLength(1);
    expect(app?.querySelector("iframe")?.dataset.src).toContain(
      "cid=second-cid",
    );
  }, 10_000);

  it("threads exact executable manifest text into the sandbox contract", async () => {
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,1,7],"runtime":{"kind":"web","entrypoint":"index.html"}}';
    const { renderAppSubdomain } = await import("@dotli/ui/bridge");

    const render = renderAppSubdomain(
      "manifest-cid",
      "manifest-app",
      executableManifest,
    );
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await render;

    const iframeUrl = new URL(mocks.iframeHosts[0].iframeUrl);
    expect(iframeUrl.searchParams.get("executableManifest")).toBe(
      executableManifest,
    );
    expect(mocks.iframeHosts[0].allow).not.toContain("accelerometer");
    expect(mocks.iframeHosts[0].allow).not.toContain("gyroscope");
  });

  it("delegates motion sensors to PolkaVM product frames with web fallbacks", async () => {
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,1,12],"runtime":{"kind":"polkavm","abiVersion":1,"entrypoint":"app.polkavm","fallback":{"kind":"web","entrypoint":"fallback/index.html"}},"capabilities":{"graphics":{"abiVersion":1,"profile":"webgpu-raster","requiredFeatures":[],"requiredLimits":{}}}}';
    const { renderAppSubdomain } = await import("@dotli/ui/bridge");

    const render = renderAppSubdomain(
      "motion-cid",
      "motion-app",
      executableManifest,
    );
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await render;

    const directives = mocks.iframeHosts[0].allow.split("; ");
    expect(directives).toContain("accelerometer");
    expect(directives).toContain("gyroscope");
  });

  it("requests motion at top level and relays physical samples to the PolkaVM frame", async () => {
    class TestDeviceMotionEvent extends Event {
      static requestPermission = vi.fn(async () => "granted" as const);
      readonly accelerationIncludingGravity = { x: 1, y: 2, z: 9 };
      readonly rotationRate = { alpha: 3, beta: 4, gamma: 5 };
    }
    vi.stubGlobal("DeviceMotionEvent", TestDeviceMotionEvent);
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,1,9],"runtime":{"kind":"polkavm","abiVersion":1,"entrypoint":"app.polkavm"},"capabilities":{"graphics":{"abiVersion":1,"profile":"webgpu-raster","requiredFeatures":[],"requiredLimits":{}}}}';
    const { renderAppSubdomain } = await import("@dotli/ui/bridge");
    const render = renderAppSubdomain(
      "motion-relay-cid",
      "motion-relay",
      executableManifest,
    );
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await render;

    const created = mocks.iframeHosts[0];
    const targetWindow = created.iframe.contentWindow;
    expect(targetWindow).not.toBeNull();
    const postMessage = vi
      .spyOn(targetWindow!, "postMessage")
      .mockImplementation(() => {});
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "dotli:pvm-motion-request" },
        origin: created.allowedOrigin,
        source: targetWindow,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "dotli:pvm-motion-request" },
        origin: created.allowedOrigin,
        source: targetWindow,
      }),
    );
    expect(
      [...document.querySelectorAll(".notif-action")].filter(
        (element) => element.textContent === "Enable motion",
      ),
    ).toHaveLength(1);
    const enable = document.querySelector<HTMLButtonElement>(".notif-action");
    expect(enable?.textContent).toBe("Enable motion");
    enable?.click();
    enable?.click();
    await vi.waitFor(() => {
      expect(TestDeviceMotionEvent.requestPermission).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith(
        { type: "dotli:pvm-motion-status", availability: 1 },
        created.allowedOrigin,
      );
    });
    const prompt = enable?.closest(".notif-card");
    expect(prompt).not.toBeNull();
    expect(prompt?.classList.contains("notif-leave")).toBe(true);
    prompt?.dispatchEvent(new Event("animationend"));
    expect(document.body.textContent).not.toContain(
      "Enable motion to tilt this application",
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "dotli:pvm-motion-request" },
        origin: created.allowedOrigin,
        source: targetWindow,
      }),
    );
    expect(document.body.textContent).not.toContain(
      "Enable motion to tilt this application",
    );

    window.dispatchEvent(new TestDeviceMotionEvent("devicemotion"));
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "dotli:pvm-motion-sample",
        timestampMs: expect.any(Number),
        acceleration: { x: 1, y: 2, z: 9 },
        rotation: { alpha: 3, beta: 4, gamma: 5 },
      },
      created.allowedOrigin,
    );
  });

  it("mediates one PVM platform command per trusted app-frame activation", async () => {
    const executableManifest =
      '{"$v":2,"kind":"app","appVersion":[0,2,0],"runtime":{"kind":"polkavm","abiVersion":1,"entrypoint":"app.polkavm"},"capabilities":{"graphics":{"abiVersion":1,"profile":"tri2d","requiredFeatures":[]}}}';
    // Import after the per-test module reset so bridge singleton state is isolated.
    const { renderAppSubdomain } = await import("@dotli/ui/bridge");
    const render = renderAppSubdomain(
      "ui-output-cid",
      "ui-output",
      executableManifest,
    );
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await render;

    const created = mocks.iframeHosts[0];
    const source = created.iframe.contentWindow;
    if (source === null) throw new Error("app frame has no content window");
    const origin = new URL(created.iframeUrl).origin;
    const activation = { isActive: false, hasBeenActive: false };
    const activationDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "userActivation",
    );
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: activation,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const dispatch = (
      data: unknown,
      messageOrigin = origin,
      messageSource: MessageEventSource = source,
    ): void => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: messageOrigin,
          source: messageSource,
        }),
      );
    };

    try {
      dispatch({
        type: "dotli:pvm-ui-command",
        command: { type: "copy-text", text: "automatic" },
      });
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();

      activation.isActive = true;
      activation.hasBeenActive = true;
      dispatch({ type: "dotli:pvm-user-activation" }, "https://evil.example");
      dispatch({
        type: "dotli:pvm-ui-command",
        command: { type: "copy-text", text: "wrong-origin" },
      });
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();

      dispatch({ type: "dotli:pvm-user-activation" });
      dispatch({
        type: "dotli:pvm-ui-command",
        command: { type: "copy-text", text: "hello" },
      });
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledExactlyOnceWith("hello");
      });
      dispatch({
        type: "dotli:pvm-ui-command",
        command: { type: "copy-text", text: "second" },
      });
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);

      dispatch({ type: "dotli:pvm-user-activation" });
      dispatch({
        type: "dotli:pvm-ui-command",
        command: {
          type: "open-url",
          url: "javascript:alert(1)",
          newSurface: true,
        },
      });
      expect(open).not.toHaveBeenCalled();

      dispatch({ type: "dotli:pvm-user-activation" });
      dispatch({
        type: "dotli:pvm-ui-command",
        command: {
          type: "open-url",
          url: "https://example.test/path",
          newSurface: true,
        },
      });
      expect(open).toHaveBeenCalledExactlyOnceWith(
        "https://example.test/path",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
      if (activationDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "userActivation");
      } else {
        Object.defineProperty(
          navigator,
          "userActivation",
          activationDescriptor,
        );
      }
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
  });

  it("reconnects the TrUAPI MessagePort after a product iframe reload", async () => {
    const { renderAppSubdomain } = await import("@dotli/ui/bridge");
    const addEventListener = vi.spyOn(window, "addEventListener");
    const render = renderAppSubdomain("reload-cid", "reload-app");
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await render;

    const created = mocks.iframeHosts[0];
    const targetWindow = created.iframe.contentWindow;
    expect(targetWindow).not.toBeNull();
    const postMessage = vi
      .spyOn(targetWindow!, "postMessage")
      .mockImplementation(() => {});
    const probe = addEventListener.mock.calls
      .filter(([type]) => type === "message")
      .at(-1)?.[1] as EventListener | undefined;
    addEventListener.mockRestore();
    expect(probe).toBeTypeOf("function");
    const ready = (): void => {
      probe?.({
        data: { type: "truapi-ready" },
        origin: created.allowedOrigin,
        source: targetWindow,
      } as MessageEvent);
    };

    ready();
    expect(postMessage).not.toHaveBeenCalled();
    ready();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message, origin, ports] = postMessage.mock.calls[0];
    expect(message).toEqual({ type: "truapi-init" });
    expect(origin).toBe(created.allowedOrigin);
    expect(ports).toHaveLength(1);
    expect(ports?.[0]).toHaveProperty("postMessage");
  });

  it("forwards a sandbox schema mismatch as a host PWA update request", async () => {
    const { renderAppSubdomain } = await import("@dotli/ui/bridge");
    const render = renderAppSubdomain("manifest-cid", "manifest-app");
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await render;

    const updateRequired = vi.fn();
    window.addEventListener("dotli:host-update-required", updateRequired, {
      once: true,
    });
    const appOrigin = new URL(mocks.iframeHosts[0].iframeUrl).origin;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "dotli:host-update-required" },
        origin: "https://evil.example",
      }),
    );
    expect(updateRequired).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "dotli:host-update-required" },
        origin: appOrigin,
      }),
    );
    expect(updateRequired).toHaveBeenCalledTimes(1);
  });

  it.each(["/x.dot@evil.com/pay", "/foo.dotify/pay"])(
    "As a user, the host keeps an adversarial deep path on the app sandbox origin: %s",
    async (path) => {
      // Given
      window.history.replaceState(null, "", path);
      const { renderAppSubdomain } = await import("@dotli/ui/bridge");

      // When
      const render = renderAppSubdomain("cid", "first");
      await waitForProviderRequests(1);
      mocks.coreProviderDefers[0].resolve(makeProvider());
      await render;

      // Then
      const created = mocks.iframeHosts[0];
      const iframeUrl = new URL(created.iframeUrl);
      expect(iframeUrl.hostname).toBe("first.app.localhost");
      expect(iframeUrl.pathname).toBe(path);
      expect(created.allowedOrigin).toBe(iframeUrl.origin);
    },
  );

  it("As a dotli integrator, the host cancels pairing on the active product host", async () => {
    // Given
    const { renderIframe } = await import("@dotli/ui/bridge");

    const render = renderIframe("https://product.example/app", "product");
    await waitForProviderRequests(1);
    mocks.coreProviderDefers[0].resolve(makeProvider());
    await render;

    // When
    window.dispatchEvent(new Event("dotli:truapi-cancel-login"));

    // Then
    expect(mocks.coreRuntimes[0].cancelPairing).toHaveBeenCalledTimes(1);
  });

  it("As a dotli integrator, the host boots the landing auth core to disconnect a stored session without a product", async () => {
    // Given
    await import("@dotli/ui/bridge");

    // When
    window.dispatchEvent(new Event("dotli:truapi-disconnect-request"));
    await waitForProviderRequests(1);

    const provider = makeProvider();
    mocks.coreProviderDefers[0].resolve(provider);
    await waitForMockCalls(provider.disconnectSession, 1);

    // Then
    expect(provider.disconnectSession).toHaveBeenCalledTimes(1);
  }, 10_000);
});

describe("requestCoreLogin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="app"></div>`;
  });

  it("As a dotli integrator, the host resolves successful login responses", async () => {
    // Given
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

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).resolves.toBe("Success");
    expect(provider.subscribe).toHaveBeenCalledTimes(1);
    expect(provider.listener).toBeNull();
  });

  it("As a dotli integrator, the host rejects typed login errors as LoginRequestError", async () => {
    // Given
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

    // When
    const promise = requestCoreLogin(provider);

    // Then
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

  it("As a dotli integrator, the host rejects host failures with the reason as the error message", async () => {
    // Given
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

    // When
    const promise = requestCoreLogin(provider);

    // Then
    await expect(promise).rejects.toThrow(reason);
    await expect(promise).rejects.toMatchObject({
      name: "LoginRequestError",
      error: { tag: "HostFailure", value: { reason } },
    });
    expect(provider.listener).toBeNull();
  });

  it("As a dotli integrator, the host rejects malformed response frames and unsubscribes", async () => {
    // Given
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const provider = makeLoginProvider({
      onPostMessage() {
        provider.listener?.(new Uint8Array([0xff, 0x00]));
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).rejects.toThrow();
    expect(provider.listener).toBeNull();
  });

  it("As a dotli integrator, the host rejects send failures and unsubscribes", async () => {
    // Given
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const provider = makeLoginProvider({
      onPostMessage() {
        throw new Error("send failed");
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).rejects.toThrow("send failed");
    expect(provider.listener).toBeNull();
  });

  it("As a dotli integrator, the host rejects and unsubscribes when the core provider closes", async () => {
    // Given
    const { requestCoreLogin } = await import("@dotli/ui/bridge");
    const provider = makeLoginProvider({});

    // When
    const promise = requestCoreLogin(provider);

    // Then
    expect(provider.listener).not.toBeNull();
    expect(provider.closeListener).not.toBeNull();

    // When
    provider.closeListener?.(new Error("core transport closed"));

    // Then
    await expect(promise).rejects.toThrow("core transport closed");
    expect(provider.listener).toBeNull();
    expect(provider.closeListener).toBeNull();
  });
});
