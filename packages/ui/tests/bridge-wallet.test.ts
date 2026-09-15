import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState, RequiredHostCallbacks } from "@parity/truapi-host";
import type { LocalIdentity } from "@parity/truapi-host/web";
import type { DotliAuthState } from "@dotli/ui/host-callbacks/AuthState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const wallet = vi.hoisted(() => ({
  account: `0x${"12".repeat(32)}`,
  revision: "original",
  username: undefined as string | undefined,
  cachedUsername: undefined as string | undefined,
  refreshGate: undefined as Promise<void> | undefined,
  claimGate: undefined as Promise<void> | undefined,
  claimStarted: false,
  failNextProduct: false,
  failProductRefresh: false,
  sessions: [] as {
    disposed: boolean;
    username?: string;
    publish: (state: AuthState) => void;
  }[],
}));

vi.mock("@dotli/config/config", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DEBUG: true,
}));
vi.mock("@dotli/shared/chat-capability", () => ({
  chatCapabilityFor: async () => false,
}));
vi.mock("@dotli/ui/notification", () => ({ showNotification: vi.fn() }));
vi.mock("@dotli/ui/host-callbacks/SessionStore", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  initializeLocalWalletState: async () => {},
  isExperimentalWalletActive: () => true,
  localWalletContext: () => ({ network: "westend", revision: wallet.revision }),
  isCurrentLocalWallet: (context: { revision: string }) =>
    context.revision === wallet.revision,
  readLocalWalletSecret: async () => new Uint8Array(16),
  readVerifiedLocalIdentity: async () => ({
    identityAccountId: wallet.account,
    liteUsername: wallet.cachedUsername,
  }),
  writeVerifiedLocalIdentity: async (
    _binding: unknown,
    identity: LocalIdentity,
  ) => {
    wallet.cachedUsername = identity.liteUsername;
  },
  onStoredSessionChanged: () => () => {},
  onVerifiedLocalIdentityChanged: () => () => {},
}));
vi.mock("@parity/truapi-host/worker-runtime?worker", () => ({
  default: class {},
}));
vi.mock("@parity/truapi-host/web", () => ({
  createWebWorkerPairingHostRuntime: vi.fn(),
  createWebWorkerSigningHostRuntime: async (
    _worker: unknown,
    callbacks: RequiredHostCallbacks,
  ) => {
    const session = {
      disposed: false,
      username: undefined as string | undefined,
      publish: (state: AuthState) => callbacks.auth.authStateChanged(state),
    };
    wallet.sessions.push(session);
    const identity = (): LocalIdentity => ({
      identityAccountId: wallet.account,
      ...(wallet.username === undefined
        ? {}
        : { liteUsername: wallet.username }),
    });
    const publish = (username?: string) => {
      if (session.disposed) throw new Error("Native session disposed");
      session.username = username;
      session.publish({
        tag: "Connected",
        value: {
          identityAccountId: wallet.account,
          publicKey: wallet.account,
          ...(username === undefined ? {} : { liteUsername: username }),
        },
      });
    };
    return {
      activateLocalSession: async () => {
        publish();
      },
      refreshLocalIdentity: async () => {
        if (wallet.failProductRefresh && wallet.sessions[0] !== session) {
          throw new Error("Product identity chain unavailable");
        }
        await wallet.refreshGate;
        publish(wallet.username);
        return identity();
      },
      registerLocalLiteUsername: async (name: string) => {
        wallet.claimStarted = true;
        await wallet.claimGate;
        wallet.username = `${name}.westend`;
        publish(wallet.username);
        return identity();
      },
      createProvider: async () => {
        if (wallet.sessions.length > 1 && wallet.failNextProduct) {
          wallet.failNextProduct = false;
          throw new Error("Product startup failed");
        }
        return {
          postMessage: () => {},
          subscribe: () => () => {},
          subscribeClose: () => () => {},
          disconnectSession: async () => {},
          getPermissionAuthorizationStatus: async () => "NotDetermined",
          getPermissionAuthorizationStatuses: async (requests: unknown[]) =>
            requests.map(() => "NotDetermined"),
          setPermissionAuthorizationStatus: async () => {},
          dispose: () => {},
        };
      },
      dispose: () => {
        session.disposed = true;
      },
    };
  },
  createIframeHost: (args: { container: HTMLElement; iframeUrl: string }) => {
    const iframe = document.createElement("iframe");
    iframe.dataset.src = args.iframeUrl;
    args.container.appendChild(iframe);
    return {
      iframe,
      dispose: () => {
        iframe.remove();
      },
    };
  },
}));

const auth: DotliAuthState[] = [];
const recordAuth = (event: Event) => {
  auth.push((event as CustomEvent<DotliAuthState>).detail);
};

async function boot() {
  const [bridge, { createBlockingModalCoordinator }] = await Promise.all([
    import("@dotli/ui/bridge"),
    import("@dotli/ui/blocking-modal-queue"),
  ]);
  bridge.initBridgeEventListeners(createBlockingModalCoordinator());
  return bridge;
}

describe("host-owned experimental identity", () => {
  beforeEach(() => {
    vi.resetModules();
    wallet.revision = "original";
    wallet.username = undefined;
    wallet.cachedUsername = undefined;
    wallet.refreshGate = undefined;
    wallet.claimGate = undefined;
    wallet.claimStarted = false;
    wallet.failNextProduct = false;
    wallet.failProductRefresh = false;
    wallet.sessions.length = 0;
    auth.length = 0;
    localStorage.clear();
    localStorage.setItem("dotli:local-wallet-enabled", "1");
    document.body.innerHTML = '<div id="app"></div>';
    window.addEventListener("dotli:truapi-auth-state", recordAuth);
  });
  afterEach(() => {
    window.removeEventListener("dotli:truapi-auth-state", recordAuth);
  });

  it("queries and claims identity before a product exists", async () => {
    const { experimentalWalletControls: controls } = await boot();
    await expect(controls.getIdentity()).resolves.toMatchObject({
      identityAccountId: wallet.account,
    });
    await expect(controls.getProduct()).resolves.toBeNull();
    await expect(controls.claimLiteUsername("alice")).resolves.toEqual({
      identityAccountId: wallet.account,
      liteUsername: "alice.westend",
    });
    expect(auth.at(-1)).toMatchObject({
      tag: "Connected",
      session: { primaryUsername: "alice.westend" },
    });
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("publishes restored native identity without trusting a disk username or emitting bare Connected", async () => {
    wallet.cachedUsername = "forged.westend";
    wallet.username = "alice.westend";
    const gate = deferred<void>();
    wallet.refreshGate = gate.promise;
    const { experimentalWalletControls: controls } = await boot();
    const query = controls.getIdentity();
    await vi.waitFor(() => expect(wallet.sessions).toHaveLength(1));
    expect(auth).toEqual([]);
    gate.resolve();
    await expect(query).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    expect(auth).toEqual([
      expect.objectContaining({
        tag: "Connected",
        session: expect.objectContaining({ primaryUsername: "alice.westend" }),
      }),
    ]);
  });

  it("keeps wallet identity and global auth through failed and successful product replacement", async () => {
    const { experimentalWalletControls: controls, renderIframe } = await boot();
    await controls.claimLiteUsername("alice");
    await renderIframe("https://first.example/", "first");
    const before = auth.slice();
    wallet.failNextProduct = true;
    await expect(
      renderIframe("https://failed.example/", "failed"),
    ).rejects.toThrow("Product startup failed");
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    expect(document.querySelector("iframe")?.dataset.src).toBe(
      "https://first.example/",
    );
    await renderIframe("https://second.example/", "second");
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    expect(auth).toEqual(before);
    // Product-native sessions verify their username too; they aren't just UI labels.
    expect(wallet.sessions.at(-1)?.username).toBe("alice.westend");
  });

  it("returns the confirmed wallet claim when a running product cannot refresh its account", async () => {
    const { experimentalWalletControls: controls, renderIframe } = await boot();
    await renderIframe("https://first.example/", "first");
    wallet.failProductRefresh = true;
    await expect(controls.claimLiteUsername("alice")).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    expect(auth.at(-1)).toMatchObject({
      tag: "Connected",
      session: { primaryUsername: "alice.westend" },
    });
  });

  it("finishes an in-flight claim while a product is replaced", async () => {
    const { experimentalWalletControls: controls, renderAppSubdomain } =
      await boot();
    await renderAppSubdomain("first-cid", "first");
    const gate = deferred<void>();
    wallet.claimGate = gate.promise;
    const claim = controls.claimLiteUsername("alice");
    await vi.waitFor(() => expect(wallet.claimStarted).toBe(true));
    const replacement = renderAppSubdomain("second-cid", "second");
    await expect(controls.getIdentity()).resolves.toMatchObject({
      identityAccountId: wallet.account,
    });
    gate.resolve();
    await expect(claim).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    await replacement;
    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    expect(wallet.sessions.at(-1)?.username).toBe("alice.westend");
    expect(auth.at(-1)).toMatchObject({
      tag: "Connected",
      session: { primaryUsername: "alice.westend" },
    });
  });

  it("surfaces a native restoration failure instead of publishing cached identity", async () => {
    wallet.cachedUsername = "forged.westend";
    const gate = deferred<void>();
    wallet.refreshGate = gate.promise;
    const { experimentalWalletControls: controls } = await boot();
    const query = controls.getIdentity();
    const failed = expect(query).rejects.toThrow("Identity chain unavailable");
    await vi.waitFor(() => expect(wallet.sessions).toHaveLength(1));
    gate.reject(new Error("Identity chain unavailable"));
    await failed;
    expect(auth.some((state) => state.tag === "Connected")).toBe(false);
    await vi.waitFor(() =>
      expect(auth.at(-1)).toMatchObject({
        tag: "LoginFailed",
        reason: "Identity chain unavailable",
      }),
    );
  });

  it("rejects a late claim and native callback from a replaced identity", async () => {
    const { experimentalWalletControls: controls } = await boot();
    await controls.getIdentity();
    const gate = deferred<void>();
    wallet.claimGate = gate.promise;
    const claim = controls.claimLiteUsername("alice");
    await vi.waitFor(() => expect(wallet.claimStarted).toBe(true));
    wallet.revision = "replacement";
    const before = auth.slice();
    gate.resolve();
    await expect(claim).rejects.toThrow("Test wallet changed");
    expect(auth).toEqual(before);
    await expect(controls.getIdentity()).rejects.toThrow(
      "wallet or network changed",
    );
  });
});
