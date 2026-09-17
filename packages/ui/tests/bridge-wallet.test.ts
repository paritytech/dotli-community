import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState, RequiredHostCallbacks } from "@parity/truapi-host";
import type {
  LocalIdentity,
  LocalIdentityProgress,
} from "@parity/truapi-host/web";
import type { DotliAuthState } from "@dotli/ui/host-callbacks/AuthState";
import type * as BridgeModule from "@dotli/ui/bridge";
import type * as ModalQueueModule from "@dotli/ui/blocking-modal-queue";

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
  closeNextProvider: false,
  sessions: [] as {
    disposed: boolean;
    username?: string;
    publish: (state: AuthState) => void;
    close: (error: Error) => void;
    closeCallbacks: Set<(error: Error) => void>;
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
    let closeError: Error | undefined;
    const closeCallbacks = new Set<(error: Error) => void>();
    const session = {
      disposed: false,
      username: undefined as string | undefined,
      publish: (state: AuthState) => callbacks.auth.authStateChanged(state),
      closeCallbacks,
      close: (error: Error) => {
        if (closeError !== undefined) return;
        closeError = error;
        session.disposed = true;
        for (const callback of [...closeCallbacks]) callback(error);
        closeCallbacks.clear();
      },
    };
    wallet.sessions.push(session);
    const assertLive = () => {
      if (session.disposed) throw new Error("Native session disposed");
    };
    const identity = (): LocalIdentity => ({
      identityAccountId: wallet.account,
      ...(wallet.username === undefined
        ? {}
        : { liteUsername: wallet.username }),
    });
    const publish = (username?: string) => {
      assertLive();
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
        assertLive();
        if (wallet.failProductRefresh && wallet.sessions[0] !== session) {
          throw new Error("Product identity chain unavailable");
        }
        await wallet.refreshGate;
        publish(wallet.username);
        return identity();
      },
      registerLocalLiteUsername: async (
        name: string,
        _backend: string,
        onProgress?: (progress: LocalIdentityProgress) => void,
      ) => {
        assertLive();
        wallet.claimStarted = true;
        onProgress?.({ stage: "checking" });
        await wallet.claimGate;
        assertLive();
        onProgress?.({ stage: "confirming" });
        wallet.username = `${name}.westend`;
        publish(wallet.username);
        return identity();
      },
      createProvider: async () => {
        assertLive();
        if (wallet.sessions.length > 1 && wallet.failNextProduct) {
          wallet.failNextProduct = false;
          throw new Error("Product startup failed");
        }
        if (wallet.closeNextProvider) {
          wallet.closeNextProvider = false;
          session.close(new Error("Wallet provider already closed"));
        }
        return {
          postMessage: () => assertLive(),
          subscribe: () => () => {},
          subscribeClose: (callback: (error: Error) => void) => {
            if (closeError !== undefined) callback(closeError);
            else closeCallbacks.add(callback);
            return () => closeCallbacks.delete(callback);
          },
          disconnectSession: async () => {},
          getPermissionAuthorizationStatus: async () => "NotDetermined",
          getPermissionAuthorizationStatuses: async (requests: unknown[]) =>
            requests.map(() => "NotDetermined"),
          setPermissionAuthorizationStatus: async () => {},
          dispose: () => session.close(new Error("Native provider disposed")),
        };
      },
      dispose: () => {
        session.close(new Error("Native session disposed"));
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

let bridge: typeof BridgeModule;
let createBlockingModalCoordinator: typeof ModalQueueModule.createBlockingModalCoordinator;

function boot() {
  bridge.initBridgeEventListeners(createBlockingModalCoordinator());
  return bridge;
}

describe("host-owned experimental identity", () => {
  beforeEach(async () => {
    vi.resetModules();
    wallet.revision = "original";
    wallet.username = undefined;
    wallet.cachedUsername = undefined;
    wallet.refreshGate = undefined;
    wallet.claimGate = undefined;
    wallet.claimStarted = false;
    wallet.failNextProduct = false;
    wallet.failProductRefresh = false;
    wallet.closeNextProvider = false;
    wallet.sessions.length = 0;
    auth.length = 0;
    localStorage.clear();
    localStorage.setItem("dotli:local-wallet-enabled", "1");
    document.body.innerHTML = '<div id="app"></div>';
    window.addEventListener("dotli:truapi-auth-state", recordAuth);
    [bridge, { createBlockingModalCoordinator }] = await Promise.all([
      import("@dotli/ui/bridge"),
      import("@dotli/ui/blocking-modal-queue"),
    ]);
  });
  afterEach(() => {
    window.removeEventListener("dotli:truapi-auth-state", recordAuth);
  });

  it("queries and claims identity before a product exists", async () => {
    const { experimentalWalletControls: controls } = boot();
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
    const { experimentalWalletControls: controls } = boot();
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
    const { experimentalWalletControls: controls, renderIframe } = boot();
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
    const { experimentalWalletControls: controls, renderIframe } = boot();
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
    const { experimentalWalletControls: controls, renderAppSubdomain } = boot();
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

  it("retires a failed owner without retiring its product and explicitly retries native operations", async () => {
    const { experimentalWalletControls: controls, renderIframe } = boot();
    await controls.claimLiteUsername("alice");
    await renderIframe("https://first.example/", "first");
    const [owner, product] = wallet.sessions;
    const lateCloseCallbacks = [...owner.closeCallbacks];
    const display = controls.getCachedIdentity();
    expect(display).toMatchObject({
      identityAccountId: wallet.account,
      primaryUsername: "alice.westend",
    });
    const before = auth.length;
    owner.close(new Error("Wallet worker terminated"));
    owner.publish({ tag: "Disconnected" });
    expect(auth.slice(before)).toEqual([
      { tag: "WalletUnavailable", reason: "Wallet worker terminated" },
    ]);
    expect(controls.getCachedIdentity()).toEqual(display);
    expect(owner.disposed).toBe(true);
    expect(product.disposed).toBe(false);
    expect(document.querySelector("iframe")?.dataset.src).toBe(
      "https://first.example/",
    );
    expect(wallet.sessions).toHaveLength(2);

    await expect(controls.getIdentity()).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    const replacement = wallet.sessions[2];
    const afterRetry = auth.slice();
    for (const callback of lateCloseCallbacks) {
      callback(new Error("Late old worker close"));
    }
    expect(auth).toEqual(afterRetry);
    expect(replacement.disposed).toBe(false);
    await expect(controls.refreshUsername()).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    await expect(controls.claimLiteUsername("bob")).resolves.toMatchObject({
      liteUsername: "bob.westend",
    });
    expect(product.disposed).toBe(false);
    expect(product.username).toBe("bob.westend");
    expect(wallet.sessions).toHaveLength(3);
  });

  it("does not publish a failure or retire a replacement after intentional owner disposal", async () => {
    const { experimentalWalletControls: controls } = boot();
    await controls.getIdentity();
    const owner = wallet.sessions[0];
    const lateCloseCallbacks = [...owner.closeCallbacks];
    const before = auth.slice();
    wallet.revision = "replacement";
    await expect(controls.getIdentity()).rejects.toThrow(
      "wallet or network changed",
    );
    expect(owner.disposed).toBe(true);
    expect(auth).toEqual(before);
    await controls.getIdentity();
    const replacement = wallet.sessions[1];
    for (const callback of lateCloseCallbacks) {
      callback(new Error("Late intentionally disposed worker"));
    }
    await expect(controls.claimLiteUsername("alice")).resolves.toMatchObject({
      liteUsername: "alice.westend",
    });
    expect(replacement.disposed).toBe(false);
    expect(auth.some((state) => state.tag === "WalletUnavailable")).toBe(false);
    expect(wallet.sessions).toHaveLength(2);
  });

  it("rejects an already-closed owner once and allows an explicit retry", async () => {
    wallet.closeNextProvider = true;
    const { experimentalWalletControls: controls } = boot();
    await expect(controls.getIdentity()).rejects.toThrow(
      "Wallet provider already closed",
    );
    expect(auth.filter((state) => state.tag === "WalletUnavailable")).toEqual([
      { tag: "WalletUnavailable", reason: "Wallet provider already closed" },
    ]);
    expect(auth.some((state) => state.tag === "LoginFailed")).toBe(false);
    expect(auth.some((state) => state.tag === "Connected")).toBe(false);
    expect(wallet.sessions[0].disposed).toBe(true);
    await expect(controls.refreshUsername()).resolves.toMatchObject({
      identityAccountId: wallet.account,
    });
    expect(wallet.sessions).toHaveLength(2);
    expect(wallet.sessions[1].disposed).toBe(false);
    expect(auth.at(-1)).toMatchObject({ tag: "Connected" });
  });

  it("surfaces a native restoration failure instead of publishing cached identity", async () => {
    wallet.cachedUsername = "forged.westend";
    const gate = deferred<void>();
    wallet.refreshGate = gate.promise;
    const { experimentalWalletControls: controls } = boot();
    const query = controls.getIdentity();
    const failed = expect(query).rejects.toThrow("Identity chain unavailable");
    await vi.waitFor(() => expect(wallet.sessions).toHaveLength(1));
    gate.reject(new Error("Identity chain unavailable"));
    await failed;
    expect(auth.some((state) => state.tag === "Connected")).toBe(false);
    await vi.waitFor(() =>
      expect(auth.at(-1)).toMatchObject({
        tag: "WalletUnavailable",
        reason: "Identity chain unavailable",
      }),
    );
    expect(auth.some((state) => state.tag === "LoginFailed")).toBe(false);
    expect(wallet.sessions[0].disposed).toBe(true);
    expect(wallet.cachedUsername).toBe("forged.westend");
  });

  it("rejects a late claim and native callback from a replaced identity", async () => {
    const { experimentalWalletControls: controls } = boot();
    await controls.getIdentity();
    const gate = deferred<void>();
    wallet.claimGate = gate.promise;
    const progress = vi.fn();
    const claim = controls.claimLiteUsername("alice", progress);
    await vi.waitFor(() => expect(wallet.claimStarted).toBe(true));
    expect(progress).toHaveBeenLastCalledWith({ stage: "checking" });
    wallet.revision = "replacement";
    const before = auth.slice();
    progress.mockClear();
    gate.resolve();
    await expect(claim).rejects.toThrow("Test wallet changed");
    expect(auth).toEqual(before);
    expect(progress).not.toHaveBeenCalled();
    await expect(controls.getIdentity()).rejects.toThrow(
      "wallet or network changed",
    );
  });
});
